import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant, type ItemReadInclude } from "@semprec/shared";
import {
  createChokePoint,
  ensureItemAutomation,
  markItemAutomationDone,
  createCollectionMetadataResolver,
  createViewTypeRegistry,
  loadFullModuleRegistry,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createGenericApplicationService } from "../genericApplicationService.js";

let admin: Pool;
let runtime: Pool;
let writer: Pool;
let tenant: string;

describe("derived item reads in the generic application service", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    writer = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
  });
  afterAll(async () => {
    await writer.end();
    await runtime.end();
    await admin.end();
  });
  it("attaches automation only when requested across item, database and view reads", async () => {
    await runInTenant(tenant, async () => {
      await seedSystem(runtime, createViewTypeRegistry());
      const cp = createChokePoint(runtime);
      const books = (await cp.listDatabases()).find((db) => db.ownerModuleId === "books");
      if (!books) throw new Error("Books missing");
      const book = await cp.createItem({ databaseId: books.id, properties: { name: "Book" } });
      const noState = await cp.createItem({ databaseId: books.id, properties: { name: "Other" } });
      await withTransaction(runtime, (client) => ensureItemAutomation(client, book.id));
      const view = await cp.createView({ databaseId: books.id, type: "table", name: "Books" });
      const emptyDatabase = await cp.createDatabase({ name: "Empty automation fixture" });
      const service = createGenericApplicationService(
        runtime,
        await createCollectionMetadataResolver(await loadFullModuleRegistry()),
      );
      const actor = { userId: "00000000-0000-4000-8000-000000000001" };
      const plain = await service.getItem(actor, { itemId: book.id });
      const pending = await service.getItem(actor, { itemId: book.id, include: ["automation"] });
      expect(pending.automation).toMatchObject({ status: "pending", attempts: 0 });
      const { automation: _omitted, ...withoutAutomation } = pending;
      expect(withoutAutomation).toEqual(plain);
      expect(await service.getItem(actor, { itemId: noState.id, include: ["automation"] })).not.toHaveProperty(
        "automation",
      );
      await withTransaction(runtime, (client) => markItemAutomationDone(client, book.id, "openLibrary"));
      const originals = new Map<PoolClient, PoolClient["query"]>();
      let reads = 0;
      const observe = (client: PoolClient) => {
        if (originals.has(client)) return;
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const original = client.query;
        originals.set(client, original);
        Object.defineProperty(client, "query", {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].includes("FROM item_automation ia")) reads++;
            return Reflect.apply(original, client, args);
          },
        });
      };
      runtime.on("acquire", observe);
      try {
        reads = 0;
        await service.queryDatabase(actor, { databaseId: books.id, limit: 50 });
        expect(reads).toBe(0);
        const emptyPage = await service.queryDatabase(actor, {
          databaseId: emptyDatabase.id,
          include: ["automation"],
          limit: 50,
        });
        expect(emptyPage.items).toEqual([]);
        expect(reads).toBe(0);
        for (const query of [
          () => service.queryDatabase(actor, { databaseId: books.id, include: ["automation"], limit: 50 }),
          () => service.queryView(actor, { viewId: view.id, include: { automation: true }, limit: 50 }),
        ]) {
          reads = 0;
          const page = await query();
          expect(reads).toBe(1);
          expect(page.items.find((row) => row.id === book.id)?.automation).toMatchObject({
            status: "found",
            source: "openLibrary",
            nextAttemptAt: null,
          });
          expect(page.items.find((row) => row.id === noState.id)).not.toHaveProperty("automation");
        }
      } finally {
        runtime.off("acquire", observe);
        for (const [client, original] of originals)
          Object.defineProperty(client, "query", {
            configurable: true,
            writable: true,
            value: original,
          });
      }
      const locked = await withTransaction(runtime, (client) =>
        client.query(
          "UPDATE item_automation SET status = 'locked' WHERE tenant_id = app_tenant_default() AND item_id = $1",
          [book.id],
        ),
      );
      expect(locked.rowCount).toBe(1);
      expect((await service.getItem(actor, { itemId: book.id, include: ["automation"] })).automation).toMatchObject({
        status: "locked",
        nextAttemptAt: null,
      });
    });
  });

  it("uses one derived projection for item and query responses despite a real edge change", async () => {
    await runInTenant(tenant, async () => {
      await seedSystem(runtime, createViewTypeRegistry());
      const cp = createChokePoint(runtime);
      const writerCp = createChokePoint(writer);
      const dbs = await cp.listDatabases();
      const db = (key: string) => {
        const found = dbs.find((entry) => entry.ownerModuleId === key);
        if (!found) throw new Error(`Missing ${key}`);
        return found.id;
      };
      const area = await cp.createItem({ databaseId: db("areas"), properties: { name: "Work" } });
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const file = await cp.createItem({ databaseId: db("files"), properties: { name: "File" } });
      const areaProperty = (await cp.listProperties(db("projects"))).find((p) => p.key === "area");
      const projectProperty = (await cp.listProperties(db("files"))).find((p) => p.key === "projects");
      if (!areaProperty || !projectProperty) throw new Error("Missing relation properties");
      await cp.createRelation({
        relationPropertyId: projectProperty.id,
        callerItemId: file.id,
        targetItemId: project.id,
      });
      const definition = await withTransaction(runtime, (client) =>
        client.query<{ id: string }>(
          "SELECT id FROM relation_definitions WHERE tenant_id = app_tenant_default() AND $1 IN (property_id_a, property_id_b)",
          [projectProperty.id],
        ),
      );
      if (definition.rows.length !== 1 || !definition.rows[0]) throw new Error("Missing project definition");
      const definitionId = definition.rows[0].id;
      const view = await cp.createView({ databaseId: db("files"), type: "table", name: "Files" });
      const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
      const service = createGenericApplicationService(runtime, resolver);
      const actor = { userId: "00000000-0000-4000-8000-000000000001" };
      const setArea = (targetItemId: string | null) =>
        writerCp.setRelation({ relationPropertyId: areaProperty.id, callerItemId: project.id, targetItemId });
      const read = async (mode: "item" | "database" | "view", include: ItemReadInclude) => {
        if (mode === "item") return service.getItem(actor, { itemId: file.id, include });
        const page =
          mode === "database"
            ? await service.queryDatabase(actor, { databaseId: db("files"), include, limit: 50 })
            : await service.queryView(actor, { viewId: view.id, include, limit: 50 });
        const row = page.items.find((entry) => entry.id === file.id);
        if (!row) throw new Error("Missing file from query");
        return row;
      };
      async function observe<T>(action: () => Promise<T>, change?: () => Promise<unknown>) {
        const originals = new Map<PoolClient, PoolClient["query"]>();
        const projectionClients = new Set<PoolClient>();
        let reads = 0;
        let changed = false;
        const onAcquire = (client: PoolClient) => {
          if (originals.has(client)) return;
          // The original is invoked with its client as receiver via Reflect.apply below.
          // eslint-disable-next-line @typescript-eslint/unbound-method
          const original = client.query;
          originals.set(client, original);
          Object.defineProperty(client, "query", {
            configurable: true,
            writable: true,
            value: (...args: unknown[]) => {
              const sql = args[0];
              const params = args[1];
              if (
                typeof sql === "string" &&
                sql.includes("FROM item_relations") &&
                sql.includes("relation_definition_id = $1") &&
                Array.isArray(params) &&
                params[0] === definitionId
              ) {
                reads++;
                projectionClients.add(client);
              }
              const result: unknown = Reflect.apply(original, client, args);
              if (sql === "COMMIT" && projectionClients.delete(client) && change && !changed) {
                if (!(result instanceof Promise)) throw new Error("Expected asynchronous commit");
                changed = true;
                return result.then(async (value: unknown) => {
                  await change();
                  return value;
                });
              }
              return result;
            },
          });
        };
        runtime.on("acquire", onAcquire);
        try {
          const result = await action();
          return { result, reads, changed };
        } finally {
          runtime.off("acquire", onAcquire);
          for (const [client, original] of originals)
            Object.defineProperty(client, "query", { configurable: true, writable: true, value: original });
        }
      }
      for (const mode of ["item", "database", "view"] as const) {
        await setArea(area.id);
        const observed = await observe(
          () => read(mode, ["links", "derived"]),
          () => setArea(null),
        );
        expect(observed.changed).toBe(true);
        expect(observed.reads).toBe(1);
        expect(observed.result.derived?.area?.values[0]?.id).toBe(area.id);
        expect(observed.result.links?.area).toMatchObject({
          valueKind: "derived",
          sources: [{ itemId: project.id, propertyKey: "area" }],
        });
        expect((await read(mode, ["links", "derived"])).derived?.area).toBeUndefined();
      }
      await setArea(null);
      const empty = await observe(
        () => read("item", ["links", "derived"]),
        () => setArea(area.id),
      );
      expect(empty.changed).toBe(true);
      expect(empty.reads).toBe(1);
      expect(empty.result.derived?.area).toBeUndefined();
      expect(empty.result.links?.area).toBeUndefined();
      expect((await read("item", ["derived"])).derived?.area?.values[0]?.id).toBe(area.id);
      const linksOnly = await observe(() => read("item", ["links"]));
      expect(linksOnly.reads).toBe(0);
      expect(linksOnly.result).not.toHaveProperty("derived");
      const supplied = await cp.getDerivedValuesForItems([file.id]);
      expect(supplied.get(file.id)?.area?.values[0]?.id).toBe(area.id);
      const disabled = await observe(() => cp.getValueLinksForItems([file.id], false, supplied));
      expect(disabled.reads).toBe(0);
      expect(disabled.result.get(file.id)).toBeUndefined();
      const emptyProjection = await cp.getDerivedValuesForItems([]);
      const preloadedEmpty = await observe(() => cp.getValueLinksForItems([file.id], true, emptyProjection));
      expect(preloadedEmpty.reads).toBe(0);
      expect(preloadedEmpty.result.get(file.id)).toBeUndefined();
    });
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
      const view = await cp.createView({ databaseId: files.id, type: "table", name: "Files" });
      for (const [include, hasLinks, hasDerived] of [
        [undefined, false, false],
        [["links"], true, false],
        [["derived"], false, true],
        [["links", "derived"], true, true],
      ] satisfies Array<[ItemReadInclude, boolean, boolean]>) {
        for (const page of [
          await service.queryDatabase(actor, { databaseId: files.id, include, limit: 50 }),
          await service.queryView(actor, { viewId: view.id, include, limit: 50 }),
        ]) {
          const row = page.items.find((entry) => entry.id === file.id);
          if (!row) throw new Error("Missing file from query");
          if (hasDerived) expect(row.derived?.area?.values[0]?.id).toBe(area.id);
          else expect(row).not.toHaveProperty("derived");
          if (hasLinks && hasDerived) expect(row.links?.area?.valueKind).toBe("derived");
          else if (hasLinks) expect(row.links).toEqual({});
          else expect(row).not.toHaveProperty("links");
        }
      }
    });
  });
});
