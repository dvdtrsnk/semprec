import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant, type ItemReadInclude } from "@alldots/shared";
import {
  createChokePoint,
  createUser,
  ensureItemAutomation,
  getDatabaseByModuleId,
  markItemAutomationDone,
  createCollectionMetadataResolver,
  createViewTypeRegistry,
  loadFullModuleRegistry,
  seedSystem,
  setInvalidationHook,
  withTransaction,
  type InvalidationEvent,
} from "@alldots/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@alldots/data/testSupport";
import { createGenericApplicationService } from "../genericApplicationService.js";

let admin: Pool;
let runtime: Pool;
let writer: Pool;
let tenant: string;

describe("derived item reads in the generic application service", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
    writer = await createRuntimeRolePool(admin, "alldots_data");
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
      const company = await cp.createItem({ databaseId: db("companies"), properties: { name: "Work" } });
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const event = await cp.createItem({
        databaseId: db("events"),
        properties: { name: "Event", date: "2026-10-16" },
      });
      const companyProperty = (await cp.listProperties(db("projects"))).find((p) => p.key === "company");
      const projectProperty = (await cp.listProperties(db("events"))).find((p) => p.key === "project");
      if (!companyProperty || !projectProperty) throw new Error("Missing relation properties");
      await cp.createRelation({
        relationPropertyId: projectProperty.id,
        callerItemId: event.id,
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
      const view = await cp.createView({ databaseId: db("events"), type: "table", name: "Events" });
      const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
      const service = createGenericApplicationService(runtime, resolver);
      const actor = { userId: "00000000-0000-4000-8000-000000000001" };
      const setCompany = (targetItemId: string | null) =>
        writerCp.setRelation({ relationPropertyId: companyProperty.id, callerItemId: project.id, targetItemId });
      const read = async (mode: "item" | "database" | "view", include: ItemReadInclude) => {
        if (mode === "item") return service.getItem(actor, { itemId: event.id, include });
        const page =
          mode === "database"
            ? await service.queryDatabase(actor, { databaseId: db("events"), include, limit: 50 })
            : await service.queryView(actor, { viewId: view.id, include, limit: 50 });
        const row = page.items.find((entry) => entry.id === event.id);
        if (!row) throw new Error("Missing event from query");
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
        await setCompany(company.id);
        const observed = await observe(
          () => read(mode, ["links", "derived"]),
          () => setCompany(null),
        );
        expect(observed.changed).toBe(true);
        expect(observed.reads).toBe(1);
        expect(observed.result.derived?.company?.values[0]?.id).toBe(company.id);
        expect(observed.result.links?.company).toMatchObject({
          valueKind: "derived",
          sources: [{ itemId: project.id, propertyKey: "company" }],
        });
        expect((await read(mode, ["links", "derived"])).derived?.company).toBeUndefined();
      }
      await setCompany(null);
      const empty = await observe(
        () => read("item", ["links", "derived"]),
        () => setCompany(company.id),
      );
      expect(empty.changed).toBe(true);
      expect(empty.reads).toBe(1);
      expect(empty.result.derived?.company).toBeUndefined();
      expect(empty.result.links?.company).toBeUndefined();
      expect((await read("item", ["derived"])).derived?.company?.values[0]?.id).toBe(company.id);
      const linksOnly = await observe(() => read("item", ["links"]));
      expect(linksOnly.reads).toBe(0);
      expect(linksOnly.result).not.toHaveProperty("derived");
      const supplied = await cp.getDerivedValuesForItems([event.id]);
      expect(supplied.get(event.id)?.company?.values[0]?.id).toBe(company.id);
      const disabled = await observe(() => cp.getValueLinksForItems([event.id], false, supplied));
      expect(disabled.reads).toBe(0);
      // Derived links disabled: the event has no stored link, so nothing is reported.
      expect(disabled.result.get(event.id)).toBeUndefined();
      const emptyProjection = await cp.getDerivedValuesForItems([]);
      const preloadedEmpty = await observe(() => cp.getValueLinksForItems([event.id], true, emptyProjection));
      expect(preloadedEmpty.reads).toBe(0);
      expect(preloadedEmpty.result.get(event.id)).toBeUndefined();
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
      const companies = database("companies"),
        projects = database("projects"),
        events = database("events");
      const company = await cp.createItem({ databaseId: companies.id, properties: { name: "Work" } });
      const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Web" } });
      const event = await cp.createItem({ databaseId: events.id, properties: { name: "Event", date: "2026-10-16" } });
      for (const [db, key, from, to] of [
        [projects.id, "company", project.id, company.id],
        [events.id, "project", event.id, project.id],
      ] as const) {
        const property = (await cp.listProperties(db)).find((entry) => entry.key === key);
        if (!property) throw new Error(`Missing ${key}`);
        await cp.createRelation({ relationPropertyId: property.id, callerItemId: from, targetItemId: to });
      }
      const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
      const service = createGenericApplicationService(runtime, resolver);
      const actor = { userId: "00000000-0000-4000-8000-000000000001" };
      const neither = await service.getItem(actor, { itemId: event.id });
      const links = await service.getItem(actor, { itemId: event.id, include: ["links"] });
      const derived = await service.getItem(actor, { itemId: event.id, include: ["derived"] });
      const both = await service.getItem(actor, { itemId: event.id, include: ["links", "derived"] });
      expect(neither).not.toHaveProperty("links");
      expect(neither).not.toHaveProperty("derived");
      // Without the derived flag no company link: the event stores none.
      expect(links.links).toEqual({});
      expect(links).not.toHaveProperty("derived");
      expect(derived.derived?.company?.values[0]?.id).toBe(company.id);
      expect(derived).not.toHaveProperty("links");
      expect(both.derived?.company?.values[0]?.id).toBe(company.id);
      expect(both.links?.company).toMatchObject({
        valueKind: "derived",
        sources: [{ itemId: project.id, propertyKey: "company" }],
      });
      const view = await cp.createView({ databaseId: events.id, type: "table", name: "Events" });
      for (const [include, hasLinks, hasDerived] of [
        [undefined, false, false],
        [["links"], true, false],
        [["derived"], false, true],
        [["links", "derived"], true, true],
      ] satisfies Array<[ItemReadInclude, boolean, boolean]>) {
        for (const page of [
          await service.queryDatabase(actor, { databaseId: events.id, include, limit: 50 }),
          await service.queryView(actor, { viewId: view.id, include, limit: 50 }),
        ]) {
          const row = page.items.find((entry) => entry.id === event.id);
          if (!row) throw new Error("Missing event from query");
          if (hasDerived) expect(row.derived?.company?.values[0]?.id).toBe(company.id);
          else expect(row).not.toHaveProperty("derived");
          if (hasLinks && hasDerived) expect(row.links?.company?.valueKind).toBe("derived");
          else if (hasLinks) expect(row.links).toEqual({});
          else expect(row).not.toHaveProperty("links");
        }
      }
    });
  });
});

describe("select option operations in the generic application service (issue #1699)", () => {
  // This suite's own pools and tenant; the suite above ends the module-level ones in its `afterAll`.
  let admin: Pool;
  let runtime: Pool;
  let tenant: string;
  const invalidation = vi.fn<(event: InvalidationEvent) => void>();

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime, createViewTypeRegistry()));
    invalidation.mockClear();
    setInvalidationHook(invalidation);
  });
  afterEach(() => setInvalidationHook(() => {}));
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** The service on the runtime role, and the tenant's Health records `tags` property. */
  async function fixture() {
    const service = createGenericApplicationService(
      runtime,
      await createCollectionMetadataResolver(await loadFullModuleRegistry()),
    );
    const tags = await runInTenant(tenant, async () => {
      const database = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "healthRecords"));
      if (!database) throw new Error("Health records database missing");
      const property = await createChokePoint(runtime).getPropertyByKey(database.id, "tags");
      if (!property) throw new Error("Health records tags property missing");
      return property;
    });
    return { service, tags };
  }

  it("adds an option for the actor and names the actor in the schema invalidation", async () => {
    const { service, tags } = await fixture();
    const actor = { userId: randomUUID() };

    const option = await runInTenant(tenant, () =>
      service.addPropertyOption(actor, { propertyId: tags.id, label: "Bylinky", color: "#34C759" }),
    );

    expect(option).toEqual({ key: "bylinky", label: "Bylinky", color: "#34C759" });
    expect(invalidation).toHaveBeenCalledExactlyOnceWith({
      scope: "schema",
      databaseId: tags.databaseId,
      userId: actor.userId,
    });
  });

  it("returns a recolored catalog option's label in the caller's locale, and in English when the caller's user row is not visible", async () => {
    const { service, tags } = await fixture();
    const czechUser = await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.com`,
      passwordHash: "unused",
      locale: "cs",
    });
    const unknownActor = { userId: randomUUID() };

    const czech = await runInTenant(tenant, () =>
      service.updatePropertyOption(
        { userId: czechUser.id },
        { propertyId: tags.id, key: "medication", color: "#FF3B30" },
      ),
    );
    const fallback = await runInTenant(tenant, () =>
      service.updatePropertyOption(unknownActor, { propertyId: tags.id, key: "epilepsy", color: "#000000" }),
    );

    expect(czech).toEqual({ key: "medication", label: "Léky", color: "#FF3B30" });
    expect(fallback).toEqual({ key: "epilepsy", label: "Epilepsy", color: "#000000" });
    expect(invalidation.mock.calls).toEqual([
      [{ scope: "schema", databaseId: tags.databaseId, userId: czechUser.id }],
      [{ scope: "schema", databaseId: tags.databaseId, userId: unknownActor.userId }],
    ]);
  });
});
