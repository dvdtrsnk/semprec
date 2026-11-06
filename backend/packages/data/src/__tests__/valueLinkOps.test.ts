import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { ModuleRegistry } from "@semprec/module-registry";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { insertValueLink } from "../chokePoint/valueLinksStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import * as registryLoader from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";

let admin: Pool;
let data: Pool;
let cp: ChokePoint;
let tenant: string;
let restoreLoader = () => {};

describe("explicit value link operations", () => {
  beforeAll(async () => {
    const registry = new ModuleRegistry(() => new Set(["fixtureLinkRuleValid", "systemDatabases"]));
    await registry.loadModule(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
    await registry.loadModule(new URL("./fixtures/linkRuleValidModule.js", import.meta.url).href);
    registry.validateLinkRules();
    const loader = vi.spyOn(registryLoader, "loadFullModuleRegistry").mockResolvedValue(registry);
    restoreLoader = () => loader.mockRestore();
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check link test role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    cp = createChokePoint(data);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
  });
  afterAll(async () => {
    restoreLoader();
    await data.end();
    await admin.end();
  });

  it("unlinks without changing the value, retains first break metadata and relinks to current source", async () => {
    await runInTenant(tenant, async () => {
      const db = await cp.createDatabase({ name: "Link test" });
      await cp.createProperty({ databaseId: db.id, key: "name", name: "Name", type: "text" });
      const source = await cp.createItem({ databaseId: db.id, properties: { name: "source" } });
      const target = await cp.createItem({ databaseId: db.id, properties: { name: "old" } });
      await withTransaction(data, (client) =>
        insertValueLink(client, {
          itemId: target.id,
          propertyKey: "name",
          ruleKey: "test",
          sources: [{ kind: "item", sourceItemId: source.id, sourcePropertyKey: "name" }],
        }),
      );
      const broken = await cp.unlinkValue({ itemId: target.id, propertyKey: "name" }, "user");
      expect(broken).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
      expect((await cp.getItem(db.id, target.id))?.properties.name).toBe("old");
      expect(await cp.unlinkValue({ itemId: target.id, propertyKey: "name" }, "agent")).toEqual(broken);
      const restored = await cp.relinkValue({ itemId: target.id, propertyKey: "name" });
      expect(restored).toMatchObject({ valueKind: "inherited", brokenBy: null, brokenAt: null });
      expect((await cp.getItem(db.id, target.id))?.properties.name).toBe("source");
      await cp.unlinkValue({ itemId: target.id, propertyKey: "name" }, "agent");
      await cp.updateItem({ databaseId: db.id, itemId: target.id, propertiesPatch: { name: "manual" } });
      expect((await cp.getValueLinksForItems([target.id])).get(target.id)?.name).toMatchObject({
        valueKind: "inheritedBroken",
        brokenBy: "agent",
      });
    });
  });

  it("publishes committed link changes and does not publish for repeated or refused unlink", async () => {
    await runInTenant(tenant, async () => {
      const db = await cp.createDatabase({ name: "Link notifications" });
      await cp.createProperty({ databaseId: db.id, key: "name", name: "Name", type: "text" });
      const source = await cp.createItem({ databaseId: db.id, properties: { name: "source" } });
      const target = await cp.createItem({ databaseId: db.id, properties: { name: "old" } });
      await withTransaction(data, (client) =>
        insertValueLink(client, {
          itemId: target.id,
          propertyKey: "name",
          ruleKey: "test",
          sources: [{ kind: "item", sourceItemId: source.id, sourcePropertyKey: "name" }],
        }),
      );
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await cp.unlinkValue({ itemId: target.id, propertyKey: "name" }, "user");
        expect(events).toContainEqual(expect.objectContaining({ scope: "item", itemId: target.id, op: "update" }));
        expect((await cp.getValueLinksForItems([target.id])).get(target.id)?.name?.valueKind).toBe("inheritedBroken");
        events.length = 0;
        await cp.unlinkValue({ itemId: target.id, propertyKey: "name" }, "user");
        await expect(cp.unlinkValue({ itemId: target.id, propertyKey: "missing" }, "user")).rejects.toMatchObject({
          code: "value_link_conflict",
        });
        expect(events).toEqual([]);
        await cp.relinkValue({ itemId: target.id, propertyKey: "name" });
        expect(events).toContainEqual(expect.objectContaining({ scope: "item", itemId: target.id, op: "update" }));
        expect((await cp.getItem(db.id, target.id))?.properties.name).toBe("source");
      } finally {
        setInvalidationHook(() => {});
      }
    });
  });

  it("isolates link changes between tenants on the runtime role", async () => {
    const otherTenant = await createTestTenant(admin);
    const setup = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        const db = await cp.createDatabase({ name: "Isolated links" });
        await cp.createProperty({ databaseId: db.id, key: "name", name: "Name", type: "text" });
        const source = await cp.createItem({ databaseId: db.id, properties: { name: "source" } });
        const target = await cp.createItem({ databaseId: db.id, properties: { name: "target" } });
        await withTransaction(data, (client) =>
          insertValueLink(client, {
            itemId: target.id,
            propertyKey: "name",
            ruleKey: "test",
            sources: [{ kind: "item", sourceItemId: source.id, sourcePropertyKey: "name" }],
          }),
        );
        return { db, target };
      });
    const first = await setup(tenant);
    const second = await setup(otherTenant);
    const state = () =>
      runInTenant(tenant, async () => ({
        item: await cp.getItem(first.db.id, first.target.id),
        links: await cp.getValueLinksForItems([first.target.id]),
      }));
    const before = await state();
    await runInTenant(otherTenant, async () => {
      for (const id of [first.target.id, randomUUID()]) {
        await expect(cp.unlinkValue({ itemId: id, propertyKey: "name" }, "user")).rejects.toMatchObject({
          status: 404,
        });
        await expect(cp.relinkValue({ itemId: id, propertyKey: "name" })).rejects.toMatchObject({ status: 404 });
      }
      expect(await cp.unlinkValue({ itemId: second.target.id, propertyKey: "name" }, "user")).toMatchObject({
        valueKind: "inheritedBroken",
      });
      expect(await cp.relinkValue({ itemId: second.target.id, propertyKey: "name" })).toMatchObject({
        valueKind: "inherited",
      });
    });
    expect(await state()).toEqual(before);
  });

  it("relinks the union of current source relations and replaces only differing target edges", async () => {
    await runInTenant(tenant, async () => {
      const projects = await cp.createDatabase({ name: "Projects" });
      const files = await cp.createDatabase({ name: "Files" });
      const { property } = await cp.createRelationProperty({
        sourceDatabaseId: files.id,
        key: "projects",
        name: "Projects",
        targetDatabaseId: projects.id,
        cardinality: "many_to_many",
      });
      const p1 = await cp.createItem({ databaseId: projects.id, properties: {} });
      const p2 = await cp.createItem({ databaseId: projects.id, properties: {} });
      const p3 = await cp.createItem({ databaseId: projects.id, properties: {} });
      const a = await cp.createItem({ databaseId: files.id, properties: {} });
      const b = await cp.createItem({ databaseId: files.id, properties: {} });
      const target = await cp.createItem({ databaseId: files.id, properties: {} });
      for (const [item, project] of [
        [a, p1],
        [b, p2],
        [target, p3],
      ] as const)
        await cp.createRelation({ relationPropertyId: property.id, callerItemId: item.id, targetItemId: project.id });
      await withTransaction(data, (client) =>
        insertValueLink(client, {
          itemId: target.id,
          propertyKey: "projects",
          ruleKey: "test",
          state: "broken",
          brokenBy: "user",
          brokenAt: new Date(),
          sources: [
            { kind: "item", sourceItemId: a.id, sourcePropertyKey: "projects" },
            { kind: "item", sourceItemId: b.id, sourcePropertyKey: "projects" },
          ],
        }),
      );
      expect(await cp.relinkValue({ itemId: target.id, propertyKey: "projects" })).toMatchObject({
        valueKind: "inherited",
      });
      expect((await cp.listItemRelations(target.id, property.id))?.map((entry) => entry.targetItemId).sort()).toEqual(
        [p1.id, p2.id].sort(),
      );
    });
  });

  it("rolls back reactivation when a relation write rejects its target", async () => {
    await runInTenant(tenant, async () => {
      const sources = await cp.createDatabase({ name: "Sources" });
      const files = await cp.createDatabase({ name: "Files" });
      const projects = await cp.createDatabase({ name: "Projects" });
      await cp.createProperty({ databaseId: sources.id, key: "value", name: "Value", type: "text" });
      const { property } = await cp.createRelationProperty({
        sourceDatabaseId: files.id,
        key: "project",
        name: "Project",
        targetDatabaseId: projects.id,
        cardinality: "one_to_one",
      });
      const source = await cp.createItem({ databaseId: sources.id, properties: { value: randomUUID() } });
      const target = await cp.createItem({ databaseId: files.id, properties: {} });
      const existing = await cp.createItem({ databaseId: projects.id, properties: {} });
      await cp.createRelation({ relationPropertyId: property.id, callerItemId: target.id, targetItemId: existing.id });
      await withTransaction(data, (client) =>
        insertValueLink(client, {
          itemId: target.id,
          propertyKey: "project",
          ruleKey: "test",
          state: "broken",
          brokenBy: "user",
          brokenAt: new Date(),
          sources: [{ kind: "item", sourceItemId: source.id, sourcePropertyKey: "value" }],
        }),
      );
      const before = await cp.getValueLinksForItems([target.id]);
      const relationsBefore = await cp.listItemRelations(target.id);
      expect(relationsBefore).toHaveLength(1);
      const jobsBefore = await admin.query<{ key: string | null }>(
        "SELECT key FROM graphile_worker.jobs WHERE key LIKE $1 ORDER BY key",
        [`valueLinksPropagate:${tenant}:%`],
      );
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(cp.relinkValue({ itemId: target.id, propertyKey: "project" })).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
        });
        expect(events).toEqual([]);
        expect(
          (
            await admin.query<{ key: string | null }>(
              "SELECT key FROM graphile_worker.jobs WHERE key LIKE $1 ORDER BY key",
              [`valueLinksPropagate:${tenant}:%`],
            )
          ).rows,
        ).toEqual(jobsBefore.rows);
      } finally {
        setInvalidationHook(() => {});
      }
      expect(await cp.getValueLinksForItems([target.id])).toEqual(before);
      expect(await cp.listItemRelations(target.id)).toEqual(relationsBefore);
    });
  });

  it("propagates a relink through the fixture-configured registered worker", async () => {
    const foreignTenant = await createTestTenant(admin);
    const foreign = await runInTenant(foreignTenant, async () => {
      await seedSystem(data);
      const areas = (await cp.listDatabases()).find((db) => db.ownerModuleId === "areas");
      if (!areas) throw new Error("Foreign Areas missing");
      const item = await cp.createItem({ databaseId: areas.id, properties: { name: "Foreign" } });
      const before = await cp.getItem(areas.id, item.id);
      expect(before).not.toBeNull();
      return { areas, item, before };
    });
    const fixture = await runInTenant(tenant, async () => {
      await seedSystem(data);
      const databases = await cp.listDatabases();
      const areas = databases.find((db) => db.ownerModuleId === "areas");
      const projects = databases.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("System databases missing");
      const source = await cp.createItem({ databaseId: areas.id, properties: { name: "Source" } });
      const target = await cp.createItem({ databaseId: areas.id, properties: { name: "Old" } });
      const project = await cp.createItem({ databaseId: projects.id, properties: {} });
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Project area relation missing");
      await cp.createRelation({ relationPropertyId: via.id, callerItemId: project.id, targetItemId: target.id });
      expect((await cp.getItem(projects.id, project.id))?.properties.name).toBe("Old");
      await withTransaction(data, (client) =>
        insertValueLink(client, {
          itemId: target.id,
          propertyKey: "name",
          ruleKey: "test",
          state: "broken",
          brokenBy: "user",
          brokenAt: new Date(),
          sources: [{ kind: "item", sourceItemId: source.id, sourcePropertyKey: "name" }],
        }),
      );
      const key = `valueLinksPropagate:${tenant}:fixtureValid.areaNameToProjectName:${target.id}:1`;
      const jobs = () => admin.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [key]);
      expect((await jobs()).rows).toEqual([]);
      expect(await cp.findItem(foreign.item.id)).toBeNull();
      expect(await cp.findItem(randomUUID())).toBeNull();
      expect(await cp.relinkValue({ itemId: target.id, propertyKey: "name" })).toMatchObject({
        valueKind: "inherited",
      });
      expect((await jobs()).rows).toEqual([{ key }]);
      return { projects, project };
    });
    const handler = createCoreTaskList(data, createActionRegistry())[CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE];
    if (!handler) throw new Error("Registered propagation worker missing");
    await runOnce({ pgPool: data, taskList: { [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: handler } });
    expect(
      (await runInTenant(tenant, () => cp.getItem(fixture.projects.id, fixture.project.id)))?.properties.name,
    ).toBe("Source");
    expect(await runInTenant(foreignTenant, () => cp.getItem(foreign.areas.id, foreign.item.id))).toEqual(
      foreign.before,
    );
  });

  it("refuses missing links, missing live sources and over-cardinality without changing state", async () => {
    await runInTenant(tenant, async () => {
      const db = await cp.createDatabase({ name: "Link test" });
      await cp.createProperty({ databaseId: db.id, key: "name", name: "Name", type: "text" });
      const a = await cp.createItem({ databaseId: db.id, properties: { name: "a" } });
      const b = await cp.createItem({ databaseId: db.id, properties: { name: "b" } });
      const target = await cp.createItem({ databaseId: db.id, properties: { name: "target" } });
      await expect(cp.unlinkValue({ itemId: target.id, propertyKey: "name" }, "user")).rejects.toMatchObject({
        status: 409,
        code: "value_link_conflict",
      });
      await withTransaction(data, (client) =>
        insertValueLink(client, {
          itemId: target.id,
          propertyKey: "name",
          ruleKey: "test",
          state: "broken",
          brokenBy: "user",
          brokenAt: new Date(),
          sources: [
            { kind: "item", sourceItemId: a.id, sourcePropertyKey: "name" },
            { kind: "item", sourceItemId: b.id, sourcePropertyKey: "name" },
          ],
        }),
      );
      const before = await cp.getValueLinksForItems([target.id]);
      await expect(cp.relinkValue({ itemId: target.id, propertyKey: "name" })).rejects.toMatchObject({
        status: 409,
        code: "value_link_conflict",
      });
      expect(await cp.getValueLinksForItems([target.id])).toEqual(before);
      expect((await cp.getItem(db.id, target.id))?.properties.name).toBe("target");
      await cp.softDeleteItem(db.id, a.id);
      await cp.softDeleteItem(db.id, b.id);
      await expect(cp.relinkValue({ itemId: target.id, propertyKey: "name" })).rejects.toMatchObject({
        status: 409,
        code: "value_link_conflict",
      });
      expect((await cp.getItem(db.id, target.id))?.properties.name).toBe("target");
      await expect(cp.relinkValue({ itemId: randomUUID(), propertyKey: "name" })).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
