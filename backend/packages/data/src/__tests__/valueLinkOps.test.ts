import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { insertValueLink } from "../chokePoint/valueLinksStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";

let admin: Pool;
let data: Pool;
let cp: ChokePoint;
let tenant: string;

describe("explicit value link operations", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(data);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
  });
  afterAll(async () => {
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
      await cp.createRelationProperty({
        sourceDatabaseId: files.id,
        key: "project",
        name: "Project",
        targetDatabaseId: projects.id,
        cardinality: "one_to_one",
      });
      const source = await cp.createItem({ databaseId: sources.id, properties: { value: randomUUID() } });
      const target = await cp.createItem({ databaseId: files.id, properties: {} });
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
      await expect(cp.relinkValue({ itemId: target.id, propertyKey: "project" })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
      });
      expect(await cp.getValueLinksForItems([target.id])).toEqual(before);
      expect(await cp.listItemRelations(target.id)).toEqual([]);
    });
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
