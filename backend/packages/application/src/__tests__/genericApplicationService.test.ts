import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createChokePoint,
  createCollectionMetadataResolver,
  createViewTypeRegistry,
  loadFullModuleRegistry,
  seedSystem,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createGenericApplicationService } from "../genericApplicationService.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;

describe("derived item reads in the generic application service", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });
  it("requires both flags for derived links and independently opts into derived values", async () => {
    await runInTenant(tenant, async () => {
      await seedSystem(runtime, createViewTypeRegistry());
      const cp = createChokePoint(runtime);
      const dbs = await cp.listDatabases();
      const database = (key: string) => {
        const db = dbs.find((entry) => entry.ownerModuleId === key);
        if (!db) throw new Error(`Missing ${key}`);
        return db;
      };
      const areas = database("areas"),
        projects = database("projects"),
        files = database("files");
      const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Work" } });
      const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Web" } });
      const file = await cp.createItem({ databaseId: files.id, properties: { name: "File" } });
      for (const [db, key, from, to] of [
        [projects.id, "area", project.id, area.id],
        [files.id, "projects", file.id, project.id],
      ] as const) {
        const property = (await cp.listProperties(db)).find((entry) => entry.key === key);
        if (!property) throw new Error(`Missing ${key}`);
        await cp.createRelation({ relationPropertyId: property.id, callerItemId: from, targetItemId: to });
      }
      const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
      const service = createGenericApplicationService(runtime, resolver);
      const actor = { userId: "00000000-0000-4000-8000-000000000001" };
      const neither = await service.getItem(actor, { itemId: file.id });
      const links = await service.getItem(actor, { itemId: file.id, include: ["links"] });
      const derived = await service.getItem(actor, { itemId: file.id, include: ["derived"] });
      const both = await service.getItem(actor, { itemId: file.id, include: ["links", "derived"] });
      expect(neither).not.toHaveProperty("links");
      expect(neither).not.toHaveProperty("derived");
      expect(links.links).toEqual({});
      expect(links).not.toHaveProperty("derived");
      expect(derived.derived?.area?.values[0]?.id).toBe(area.id);
      expect(derived).not.toHaveProperty("links");
      expect(both.derived?.area?.values[0]?.id).toBe(area.id);
      expect(both.links?.area).toMatchObject({
        valueKind: "derived",
        sources: [{ itemId: project.id, propertyKey: "area" }],
      });
    });
  });
});
