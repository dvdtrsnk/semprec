import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { expandItemRelations } from "../chokePoint/relationExpansion.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { createCollectionMetadataResolver, type CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createBlob } from "../blobs/blobsStore.js";
import type { ItemRow } from "../types.js";
let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let resolver: CollectionMetadataResolver;
async function database(key: string) {
  const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, key));
  if (!db) throw new Error("Missing seeded database");
  return db;
}
async function make(key: string, properties: Record<string, unknown>) {
  return cp.createItem({ databaseId: (await database(key)).id, properties });
}
async function link(item: ItemRow, key: string, target: ItemRow, metadata?: Record<string, unknown>) {
  const property = (await cp.listProperties(item.databaseId)).find((p) => p.key === key);
  if (!property) throw new Error("Missing relation property");
  return cp.createRelation({
    relationPropertyId: property.id,
    callerItemId: item.id,
    targetItemId: target.id,
    metadata,
  });
}
async function expand(items: ItemRow[], relations: Record<string, string[]> | true) {
  return withTransaction(pool, (client) => expandItemRelations(client, items, { relations, resolver }));
}
describe("batched relation expansion", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:verify-runtime-role", () =>
      pool.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
    cp = createChokePoint(pool);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, async () => {
      await seedSystem(pool);
      resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
    });
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("expands companies and projects, with an area's own appearance at one nested level", async () =>
    runInTenant(tenant, async () => {
      const person = await make("people", { name: "Person" });
      const company = await make("companies", { name: "Company" });
      const project = await make("projects", { name: "Project", color: "#FF9500" });
      const area = await make("areas", { name: "Work", icon: "briefcase", color: "#5856D6" });
      await link(person, "companies", company, { addedAt: "2026-01-01" });
      await link(person, "projects", project);
      await link(project, "area", area);
      const [result] = await expand([person], { companies: [], projects: ["area"] });
      expect(result?.relations?.companies).toMatchObject([
        { id: company.id, title: "Company", icon: "building", metadata: { addedAt: "2026-01-01" } },
      ]);
      expect(result?.relations?.projects).toMatchObject([
        {
          id: project.id,
          color: "#FF9500",
          icon: "folder",
          properties: { area: [{ id: area.id, title: "Work", icon: "briefcase", color: "#5856D6" }] },
        },
      ]);
      expect(result?.relationsTruncated).toEqual([]);
    }));
  it("returns first 50 live targets ordered by edge and flags truncation, excluding trashed targets first", async () =>
    runInTenant(tenant, async () => {
      const person = await make("people", { name: "Person" });
      const edges = [];
      for (let i = 0; i < 52; i++) {
        const company = await make("companies", { name: `Company ${i}` });
        const edge = await link(person, "companies", company);
        edges.push({ edge, company });
      }
      const sorted = edges.sort((a, b) => a.edge.id.localeCompare(b.edge.id));
      await cp.softDeleteItem(sorted[0]!.company.databaseId, sorted[0]!.company.id);
      const [result] = await expand([person], { companies: [] });
      expect(result?.relations?.companies?.map((target) => target.id)).toEqual(
        sorted.slice(1, 51).map(({ company }) => company.id),
      );
      expect(result?.relationsTruncated).toEqual(["companies"]);
    }));
  it("orders dated edges by their addedAt metadata", async () =>
    runInTenant(tenant, async () => {
      const person = await make("people", { name: "Person" });
      const later = await make("companies", { name: "Later" });
      const earlier = await make("companies", { name: "Earlier" });
      await link(person, "companies", later, { addedAt: "2026-01-02T00:00:00.000Z" });
      await link(person, "companies", earlier, { addedAt: "2026-01-01T00:00:00.000Z" });
      const [result] = await expand([person], { companies: [] });
      expect(result?.relations?.companies?.map((target) => target.id)).toEqual([earlier.id, later.id]);
    }));
  it("supports a one-way relation, projected visible blob maps and database appearance defaults", async () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const target = await cp.createDatabase({ name: "Target" });
      await cp.createProperty({ databaseId: target.id, key: "name", name: "Name", type: "title" });
      await cp.createProperty({ databaseId: target.id, key: "cover", name: "Cover", type: "image" });
      await cp.createProperty({ databaseId: target.id, key: "attachment", name: "Attachment", type: "file" });
      const relation = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "targets",
        name: "Targets",
        targetDatabaseId: target.id,
      });
      const blob = await withTransaction(pool, (client) =>
        createBlob(client, { storageKey: `${randomUUID()}-cover.png`, mimeType: "image/png", byteSize: 15 }),
      );
      const attachment = await withTransaction(pool, (client) =>
        createBlob(client, { storageKey: `legacy-${randomUUID()}`, mimeType: "application/pdf", byteSize: 19 }),
      );
      const a = await cp.createItem({ databaseId: source.id, properties: {} });
      const b = await cp.createItem({
        databaseId: target.id,
        properties: { name: "Target", cover: { blobId: blob.id }, attachment: { blobId: attachment.id } },
      });
      await cp.createRelation({ relationPropertyId: relation.property.id, callerItemId: a.id, targetItemId: b.id });
      const [result] = await expand([a], { targets: ["cover"] });
      expect(result?.relations?.targets).toMatchObject([
        {
          id: b.id,
          icon: "database",
          color: "#FF9500",
          properties: { cover: { blobId: blob.id } },
          blobs: { cover: { blobId: blob.id, mimeType: "image/png", byteSize: 15, filename: "cover.png" } },
        },
      ]);
      expect(result?.relations?.targets?.[0]?.blobs).not.toHaveProperty("attachment");
      const [withAttachment] = await expand([a], { targets: ["attachment"] });
      expect(withAttachment?.relations?.targets).toMatchObject([
        {
          id: b.id,
          properties: { attachment: { blobId: attachment.id } },
          blobs: { attachment: { blobId: attachment.id, mimeType: "application/pdf", byteSize: 19, filename: null } },
        },
      ]);
      expect(withAttachment?.relations?.targets?.[0]?.blobs).not.toHaveProperty("cover");
      expect((await expand([a], { targets: [] }))[0]?.relations?.targets?.[0]).not.toHaveProperty("blobs");
      await cp.archiveDatabase(target.id);
      expect((await expand([a], { targets: [] }))[0]?.relations?.targets).toEqual([]);
    }));
  it("rejects unknown relation/projection keys and schema fan-out limits", async () =>
    runInTenant(tenant, async () => {
      const person = await make("people", { name: "Person" });
      const cases: [Record<string, string[]>, string][] = [
        [{ bad: [] }, "include.relations.bad"],
        [{ companies: ["bad"] }, "include.relations.companies.bad"],
        [Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`key${i}`, []])), "include.relations"],
        [{ companies: Array(11).fill("name") }, "include.relations.companies"],
      ];
      for (const [relations, field] of cases) {
        await expect(expand([person], relations)).rejects.toMatchObject({ status: 400, details: { field } });
      }
      const project = await make("projects", { name: "Project" });
      await expect(expand([project], true)).rejects.toMatchObject({ details: { field: "include.relations" } });
    }));
  it("keeps SQL statement count constant from one source item to fifty", async () =>
    runInTenant(tenant, async () => {
      const company = await make("companies", { name: "Company" });
      const people = [];
      for (let i = 0; i < 50; i++) {
        const person = await make("people", { name: `Person ${i}` });
        await link(person, "companies", company);
        people.push(person);
      }
      async function count(items: ItemRow[]) {
        return withTransaction(pool, async (client) => {
          const spy = vi.spyOn(client, "query");
          try {
            await expandItemRelations(client, items, { relations: { companies: [] }, resolver });
            expect(
              spy.mock.calls.every(
                ([sql]) => typeof sql === "string" && !/^\s*(INSERT|UPDATE|DELETE|ALTER)\b/i.test(sql),
              ),
            ).toBe(true);
            return spy.mock.calls.length;
          } finally {
            spy.mockRestore();
          }
        });
      }
      expect(await count(people)).toBe(await count(people.slice(0, 1)));
    }));
  it("keeps actual database and view query statement counts constant for one or fifty expanded items", async () =>
    runInTenant(tenant, async () => {
      const peopleDb = await database("people");
      const company = await make("companies", { name: "Company" });
      for (let i = 0; i < 50; i++) {
        const person = await make("people", { name: `Person ${i}` });
        await link(person, "companies", company);
      }
      const view = await cp.createView({ databaseId: peopleDb.id, name: "People", type: "table" });
      const wrapped = new Map<PoolClient, PoolClient["query"]>();
      let statements = 0;
      const instrument = (client: PoolClient) => {
        if (wrapped.has(client)) return;
        // eslint-disable-next-line @typescript-eslint/unbound-method
        wrapped.set(client, client.query);
        // eslint-disable-next-line @typescript-eslint/unbound-method
        client.query = new Proxy(client.query, {
          apply(target, receiver, args: unknown[]) {
            if (typeof args[0] === "string") statements += 1;
            return Reflect.apply(target, receiver, args);
          },
        });
      };
      const restore = (_error: Error, client: PoolClient) => {
        const original = wrapped.get(client);
        if (original) {
          client.query = original;
          wrapped.delete(client);
        }
      };
      pool.on("acquire", instrument);
      pool.on("release", restore);
      try {
        const include = { relations: { companies: [] }, resolver };
        for (const query of [
          (limit: number) => cp.queryDatabaseItems(peopleDb.id, { limit }, include),
          (limit: number) => cp.queryViewItems(view.id, { limit }, include),
        ]) {
          statements = 0;
          const one = await query(1);
          const oneCount = statements;
          expect(wrapped.size).toBe(0);
          expect(one.items).toHaveLength(1);
          expect(one.items[0]).toMatchObject({ relations: { companies: [{ id: company.id }] } });
          statements = 0;
          const many = await query(50);
          expect(wrapped.size).toBe(0);
          expect(many.items).toHaveLength(50);
          for (const item of many.items) expect(item).toMatchObject({ relations: { companies: [{ id: company.id }] } });
          expect(statements).toBe(oneCount);
        }
      } finally {
        pool.off("acquire", instrument);
        pool.off("release", restore);
        for (const [client, query] of wrapped) client.query = query;
        wrapped.clear();
      }
    }));
  it("rejects malformed historical JSON objects at each expansion boundary", async () =>
    runInTenant(tenant, async () => {
      const person = await make("people", { name: "Person" });
      const company = await make("companies", { name: "Company" });
      const edge = await link(person, "companies", company);
      expect((await expand([person], { companies: [] }))[0]?.relations?.companies).toMatchObject([{ id: company.id }]);
      await pool.query("UPDATE item_relations SET metadata = '[]'::jsonb WHERE id = $1", [edge.id]);
      await expect(expand([person], { companies: [] })).rejects.toThrow();
      await pool.query("UPDATE item_relations SET metadata = '{}'::jsonb WHERE id = $1", [edge.id]);
      await pool.query("UPDATE items SET properties = '[]'::jsonb WHERE database_id = $1 AND id = $2", [
        company.databaseId,
        company.id,
      ]);
      await expect(expand([person], { companies: [] })).rejects.toThrow();
      await pool.query(
        "UPDATE items SET properties = $3::jsonb, computed = '[]'::jsonb WHERE database_id = $1 AND id = $2",
        [company.databaseId, company.id, JSON.stringify(company.properties)],
      );
      await expect(expand([person], { companies: [] })).rejects.toThrow();
      await pool.query("UPDATE items SET computed = '{}'::jsonb WHERE database_id = $1 AND id = $2", [
        company.databaseId,
        company.id,
      ]);
      const project = await make("projects", { name: "Project" });
      const area = await make("areas", { name: "Area" });
      await link(person, "projects", project);
      await link(project, "area", area);
      expect((await expand([person], { projects: ["area"] }))[0]?.relations?.projects).toHaveLength(1);
      await pool.query("UPDATE items SET properties = '[]'::jsonb WHERE database_id = $1 AND id = $2", [
        area.databaseId,
        area.id,
      ]);
      await expect(expand([person], { projects: ["area"] })).rejects.toThrow();
    }));
  it("validates relation keys even for empty database and view pages", async () =>
    runInTenant(tenant, async () => {
      const db = await database("people");
      const options = { relations: { bad: [] }, resolver };
      await expect(cp.queryDatabaseItems(db.id, {}, options)).rejects.toMatchObject({
        details: { field: "include.relations.bad" },
      });
      const view = await cp.createView({ databaseId: db.id, name: "People view", type: "table" });
      await expect(cp.queryViewItems(view.id, {}, options)).rejects.toMatchObject({
        details: { field: "include.relations.bad" },
      });
    }));
  it("omits unresolved appearance independently without writing fallback values", async () =>
    runInTenant(tenant, async () => {
      const person = await make("people", { name: "Person" });
      const company = await make("companies", { name: "Company" });
      await link(person, "companies", company);
      const partial: CollectionMetadataResolver = {
        resolve: () => ({
          icon: "building",
          color: null,
          overviewOrder: null,
          switcherOrder: null,
          clientVisible: true,
        }),
      };
      const [result] = await withTransaction(pool, (client) =>
        expandItemRelations(client, [person], { relations: { companies: [] }, resolver: partial }),
      );
      expect(result?.relations?.companies?.[0]).toHaveProperty("icon", "building");
      expect(result?.relations?.companies?.[0]).not.toHaveProperty("color");
      expect((await cp.getItem(company.databaseId, company.id))?.properties).not.toHaveProperty("icon");
    }));
  it("omits metadata of missing and foreign blobs while retaining projected values", async () => {
    const other = await createTestTenant(admin);
    const foreignBlob = await runInTenant(other, () =>
      withTransaction(pool, (client) =>
        createBlob(client, { storageKey: "private.pdf", mimeType: "application/pdf", byteSize: 23 }),
      ),
    );
    await runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const target = await cp.createDatabase({ name: "Target" });
      await cp.createProperty({ databaseId: target.id, key: "file", name: "File", type: "file" });
      const relation = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "targets",
        name: "Targets",
        targetDatabaseId: target.id,
      });
      const a = await cp.createItem({ databaseId: source.id, properties: {} });
      const missingBlobId = randomUUID();
      for (const blobId of [foreignBlob.id, missingBlobId]) {
        const b = await cp.createItem({ databaseId: target.id, properties: {} });
        // A legacy invalid reference predating the blob-reference write hook.
        const updated = await pool.query<{ id: string }>(
          "UPDATE items SET properties = jsonb_build_object('file', jsonb_build_object('blobId', $3::text)) WHERE database_id = $1 AND id = $2 RETURNING id",
          [target.id, b.id, blobId],
        );
        expect(updated.rows.map((row) => row.id)).toEqual([b.id]);
        await cp.createRelation({ relationPropertyId: relation.property.id, callerItemId: a.id, targetItemId: b.id });
      }
      const [result] = await expand([a], { targets: ["file"] });
      expect(result?.relations?.targets).toHaveLength(2);
      for (const target of result?.relations?.targets ?? []) {
        expect(target.properties).toHaveProperty("file");
        expect(target).not.toHaveProperty("blobs");
      }
      expect((result?.relations?.targets ?? []).map((target) => target.properties?.file)).toEqual(
        expect.arrayContaining([{ blobId: foreignBlob.id }, { blobId: missingBlobId }]),
      );
    });
  });
  it("never exposes a foreign target even through a dangling legacy edge", async () => {
    const foreign = await runInTenant(tenant, () => make("companies", { name: "Private company" }));
    const other = await createTestTenant(admin);
    await runInTenant(other, async () => {
      await seedSystem(pool);
      const own = await make("people", { name: "Own person" });
      const property = (await cp.listProperties(own.databaseId)).find((p) => p.key === "companies");
      if (!property || typeof property.config.relationDefinitionId !== "string") throw new Error("Missing relation");
      // Deliberately malformed legacy edge: normal relation writes refuse foreign endpoints.
      await pool.query("INSERT INTO item_relations (relation_definition_id,item_a,item_b) VALUES ($1,$2,$3)", [
        property.config.relationDefinitionId,
        own.id,
        foreign.id,
      ]);
      expect((await expand([own], { companies: [] }))[0]?.relations?.companies).toEqual([]);
    });
  });
});
