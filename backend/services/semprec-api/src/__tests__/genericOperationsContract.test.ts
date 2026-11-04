import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  tenantForNextTestUser,
  registerRelationEdgeChangedHook,
  clearHooksForTests,
  type RelationEdgeChangedHookContext,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createDocStore,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type ChokePoint,
  type ItemRow,
  type PasswordResetMailer,
  type PropertyRow,
  type ViewRow,
} from "@semprec/data";
import { GENERIC_OPERATION_NAMES, runAsSystem, runInTenant, type GenericOperationName } from "@semprec/shared";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry = await loadFullModuleRegistry();

async function authHeader(): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

interface Fixtures {
  database: { id: string };
  property: PropertyRow;
  itemA: ItemRow;
  itemB: ItemRow;
  curatedView: ViewRow;
  targetDatabase: { id: string };
  targetItem: ItemRow;
  relationProperty: PropertyRow;
}

async function buildFixtures(): Promise<Fixtures> {
  const database = await chokePoint.createDatabase({ name: "Contract DB" });
  const property = await chokePoint.createProperty({
    databaseId: database.id,
    key: "title",
    name: "Title",
    type: "text",
  });
  const itemA = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Arrival" } });
  const itemB = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Dune" } });
  const curatedView = await chokePoint.createView({
    type: "list",
    name: "Collection",
    config: { membership: "manual" },
  });
  await chokePoint.addViewItem({ viewId: curatedView.id, itemId: itemA.id, position: 0, actor: { type: "user" } });

  const targetDatabase = await chokePoint.createDatabase({ name: "Contract Targets" });
  const targetItem = await chokePoint.createItem({ databaseId: targetDatabase.id, properties: {} });
  const { property: relationProperty } = await chokePoint.createRelationProperty({
    sourceDatabaseId: database.id,
    key: "assignedTo",
    name: "Assigned To",
    targetDatabaseId: targetDatabase.id,
    inverse: { key: "assignedFrom", name: "Assigned From" },
  });
  await chokePoint.createRelation({
    relationPropertyId: relationProperty.id,
    callerItemId: itemA.id,
    targetItemId: targetItem.id,
  });

  return { database, property, itemA, itemB, curatedView, targetDatabase, targetItem, relationProperty };
}

type ContractCase = (fx: Fixtures, headers: Record<string, string>, baseUrl: string) => Promise<void>;

/**
 * One REST exercise per operation in the closed 32-operation catalog (issue #219's acceptance
 * criterion: "a parameterized contract test covers all 28 operations over REST", extended to
 * `property.getByKey` by issue #432). Each case
 * issues the real HTTP request a REST caller would send and asserts only that it reaches
 * `genericApplicationService` through `GENERIC_OPERATION_BINDINGS` and succeeds — the exhaustive
 * per-field/per-error-branch behavior for each route already lives in its own handler test file
 * (`itemsHandler.test.ts`, `databasesHandler.test.ts`, `propertiesHandler.test.ts`,
 * `viewsHandler.test.ts`). The `Object.keys(CASES)` assertion below is what keeps this list
 * honest as the catalog evolves: a 31st operation with no case here fails that assertion, not
 * silently passes with 29 stale entries.
 */
const CASES: Record<GenericOperationName, ContractCase> = {
  "database.list": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/databases`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { databases: { id: string }[] };
    expect(body.databases.some((d) => d.id === fx.database.id)).toBe(true);
  },
  "database.get": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/databases/${fx.database.id}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(fx.database.id);
  },
  "database.create": async (_fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/databases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Contract Create" }),
    });
    expect(res.status).toBe(201);
  },
  "database.patch": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/databases/${fx.database.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("Renamed");
  },
  "database.archive": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/databases/${fx.database.id}`, { method: "DELETE", headers });
    expect(res.status).toBe(200);
  },
  "database.restore": async (fx, headers, baseUrl) => {
    await fetch(`${baseUrl}/api/databases/${fx.database.id}`, { method: "DELETE", headers });
    const res = await fetch(`${baseUrl}/api/databases/${fx.database.id}/restore`, { method: "POST", headers });
    expect(res.status).toBe(200);
  },
  "property.list": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/properties?databaseId=${fx.database.id}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { properties: { id: string; config: Record<string, unknown> }[] };
    const found = body.properties.find((p) => p.id === fx.property.id);
    expect(found).toBeDefined();
    // The raw row, not the localized catalog projection: `config` proves it wasn't stripped.
    expect(found?.config).toBeDefined();
  },
  "property.get": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/properties/${fx.property.id}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; config: Record<string, unknown> };
    expect(body.id).toBe(fx.property.id);
    expect(body.config).toBeDefined();
  },
  // REST exposes `property.getByKey` only through the relation routes' `:propertyKey` resolution
  // (issue #432): a RELATION key resolves, a same-database non-relation key is filtered out by the
  // operation's `type` and answers 404.
  "property.getByKey": async (fx, headers, baseUrl) => {
    const resolved = await fetch(
      `${baseUrl}/api/items/${fx.itemB.id}/relations/${fx.relationProperty.key}/${fx.targetItem.id}`,
      { method: "PUT", headers, body: "{}" },
    );
    expect(resolved.status).toBe(200);
    const filtered = await fetch(
      `${baseUrl}/api/items/${fx.itemB.id}/relations/${fx.property.key}/${fx.targetItem.id}`,
      { method: "PUT", headers, body: "{}" },
    );
    expect(filtered.status).toBe(404);
  },
  "property.create": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/databases/${fx.database.id}/properties`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "score", name: "Score", type: "number" }),
    });
    expect(res.status).toBe(201);
  },
  "property.patch": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/properties/${fx.property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "New Title" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("New Title");
  },
  "property.delete": async (fx, headers, baseUrl) => {
    const scratch = await chokePoint.createProperty({
      databaseId: fx.database.id,
      key: "scratch",
      name: "Scratch",
      type: "text",
    });
    const res = await fetch(`${baseUrl}/api/properties/${scratch.id}`, { method: "DELETE", headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PropertyRow;
    expect(body).toEqual(scratch);
  },
  "view.list": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/views`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { views: { id: string }[] };
    expect(body.views.some((v) => v.id === fx.curatedView.id)).toBe(true);
  },
  "view.get": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/views/${fx.curatedView.id}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(fx.curatedView.id);
  },
  "view.create": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/databases/${fx.database.id}/views`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "table", name: "All rows" }),
    });
    expect(res.status).toBe(201);
  },
  "view.patch": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/views/${fx.curatedView.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Renamed view" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("Renamed view");
  },
  "view.delete": async (_fx, headers, baseUrl) => {
    const scratch = await chokePoint.createView({ type: "list", name: "Scratch", config: { membership: "manual" } });
    const res = await fetch(`${baseUrl}/api/views/${scratch.id}`, { method: "DELETE", headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ViewRow;
    expect(body).toEqual(scratch);
  },
  "view.query": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/views/${fx.curatedView.id}/query`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(res.status).toBe(200);
  },
  "viewItem.add": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/views/${fx.curatedView.id}/items/${fx.itemB.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ position: 1 }),
    });
    expect(res.status).toBe(200);
  },
  "viewItem.remove": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/views/${fx.curatedView.id}/items/${fx.itemA.id}`, {
      method: "DELETE",
      headers,
    });
    expect(res.status).toBe(200);
  },
  "viewItem.reorder": async (fx, headers, baseUrl) => {
    await chokePoint.addViewItem({
      viewId: fx.curatedView.id,
      itemId: fx.itemB.id,
      position: 1,
      actor: { type: "user" },
    });
    const res = await fetch(`${baseUrl}/api/views/${fx.curatedView.id}/items/${fx.itemB.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ position: 0 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { position: number };
    expect(body.position).toBe(0);
  },
  "item.get": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/items/${fx.itemA.id}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(fx.itemA.id);
  },
  "item.create": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/databases/${fx.database.id}/items`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        properties: { title: "Contract Item" },
        relations: [{ propertyKey: fx.relationProperty.key, targetItemIds: [fx.targetItem.id] }],
      }),
    });
    expect(res.status).toBe(201);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ properties: { title: "Contract Item" } });
  },
  "item.patch": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/items/${fx.itemA.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ properties: { title: "Updated" }, ifVersion: fx.itemA.updatedAt }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { properties: Record<string, unknown> };
    expect(body.properties.title).toBe("Updated");
  },
  "item.delete": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/items/${fx.itemB.id}`, { method: "DELETE", headers });
    expect(res.status).toBe(200);
  },
  "item.restore": async (fx, headers, baseUrl) => {
    await fetch(`${baseUrl}/api/items/${fx.itemB.id}`, { method: "DELETE", headers });
    const res = await fetch(`${baseUrl}/api/items/${fx.itemB.id}/restore`, { method: "POST", headers });
    expect(res.status).toBe(200);
  },
  "database.query": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/databases/${fx.database.id}/query`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(res.status).toBe(200);
  },
  "relation.put": async (fx, headers, baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/items/${fx.itemB.id}/relations/${fx.relationProperty.key}/${fx.targetItem.id}`,
      { method: "PUT", headers, body: JSON.stringify({ metadata: { role: "tester" } }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { itemA: string; itemB: string };
    expect([body.itemA, body.itemB]).toContain(fx.itemB.id);
  },
  "relation.set": async (fx, headers, baseUrl) => {
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: fx.database.id,
      key: "singleTarget",
      name: "Single target",
      targetDatabaseId: fx.targetDatabase.id,
      cardinality: "one_to_one",
    });
    const res = await fetch(`${baseUrl}/api/items/${fx.itemB.id}/relations/${property.key}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ targetItemId: fx.targetItem.id }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ itemA: fx.itemB.id, itemB: fx.targetItem.id });
  },
  "relation.delete": async (fx, headers, baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/items/${fx.itemA.id}/relations/${fx.relationProperty.key}/${fx.targetItem.id}`,
      { method: "DELETE", headers },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { itemA: string; itemB: string };
    expect([body.itemA, body.itemB]).toContain(fx.itemA.id);
  },
  "relation.list": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/relations`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relations: { targetItemId: string }[] };
    expect(body.relations.map((relation) => relation.targetItemId)).toEqual([fx.targetItem.id]);
  },
  "page.restoreVersion": async (fx, headers, baseUrl) => {
    // A page whose history opens an hour ago, restored to half an hour ago: the one block it had is still there.
    await createDocStore(pool).putBlock(
      fx.itemA.id,
      { id: "b1", flavour: "paragraph", fields: { content: "first" } },
      "user",
    );
    await pool.query(`UPDATE docs SET history_available_from = now() - interval '1 hour' WHERE item_id = $1`, [
      fx.itemA.id,
    ]);
    await pool.query(
      `UPDATE doc_snapshot_history SET represented_at = now() - interval '1 hour'
       WHERE through_update_id = 0 AND doc_id = (SELECT id FROM docs WHERE item_id = $1)`,
      [fx.itemA.id],
    );
    // The block's update is dated an hour back too, so the page at the instant already had it.
    await pool.query(
      `UPDATE doc_updates SET created_at = now() - interval '1 hour'
       WHERE doc_id = (SELECT id FROM docs WHERE item_id = $1)`,
      [fx.itemA.id],
    );
    await pool.query(
      `UPDATE doc_history_updates SET created_at = now() - interval '1 hour'
       WHERE doc_id = (SELECT id FROM docs WHERE item_id = $1)`,
      [fx.itemA.id],
    );
    const res = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page/restore`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { itemId: string; blockIds: string[] };
    expect(body.itemId).toBe(fx.itemA.id);
    expect(body.blockIds).toEqual(["b1"]);
  },
};

describe("generic operation REST contract (issue #219)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());

    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    clearHooksForTests();
    await pool?.end();
  });

  it("reports a changed edge for REST relation deletion", async () => {
    const fx = await buildFixtures();
    const calls: RelationEdgeChangedHookContext[] = [];
    registerRelationEdgeChangedHook(async (context) => {
      calls.push(context);
    });
    const response = await fetch(
      `${baseUrl}/api/items/${fx.itemA.id}/relations/${fx.relationProperty.key}/${fx.targetItem.id}`,
      {
        method: "DELETE",
        headers: await authHeader(),
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      op: "delete",
      propertyId: fx.relationProperty.id,
      itemA: fx.itemA.id,
      itemB: fx.targetItem.id,
      writer: { writerKind: "user" },
    });
  });

  it("sets, repeats, clears and rejects a multi-valued relation through REST", async () => {
    const fx = await buildFixtures();
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: fx.database.id,
      targetDatabaseId: fx.targetDatabase.id,
      key: "singleTarget",
      name: "Single target",
      cardinality: "one_to_one",
    });
    const set = (key: string, targetItemId: string | null) =>
      fetch(`${baseUrl}/api/items/${fx.itemB.id}/relations/${key}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ targetItemId }),
      });
    const first = await set(property.key, fx.targetItem.id);
    expect(first.status).toBe(200);
    const edge: unknown = await first.json();
    const repeated = await set(property.key, fx.targetItem.id);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(edge);
    const invalid = await set(fx.relationProperty.key, fx.targetItem.id);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "validation_failed", details: { field: "propertyKey" } },
    });
    const clear = await set(property.key, null);
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({ deleted: true });
    expect((await set(property.key, null)).status).toBe(200);
  });

  it("rejects nonempty and non-object item DELETE bodies before dispatch", async () => {
    const fx = await buildFixtures();
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    for (const body of [{ reason: "private reason" }, { unexpected: true }, []]) {
      const response = await fetch(`${baseUrl}/api/items/${fx.itemA.id}`, {
        method: "DELETE",
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
      expect((await fetch(`${baseUrl}/api/items/${fx.itemA.id}`, { headers })).status).toBe(200);
    }
    expect((await fetch(`${baseUrl}/api/items/${fx.itemB.id}`, { method: "DELETE", headers, body: "{}" })).status).toBe(
      200,
    );
    expect((await fetch(`${baseUrl}/api/items/${fx.itemA.id}`, { method: "DELETE", headers })).status).toBe(200);
  });

  it("returns the same expansion on item, database and view reads while retaining path and links", async () => {
    const fx = await buildFixtures();
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const item = await fetch(`${baseUrl}/api/items/${fx.itemA.id}?include=path,links,relations&relations.assignedTo=`, {
      headers,
    });
    expect(item.status).toBe(200);
    const body: unknown = await item.json();
    expect(body).toMatchObject({
      links: {},
      relations: { assignedTo: [{ id: fx.targetItem.id, icon: "database", color: "#FF9500" }] },
      relationsTruncated: [],
    });
    expect(body).toHaveProperty("path");
    for (const path of [`/api/databases/${fx.database.id}/query`, `/api/views/${fx.curatedView.id}/query`]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ include: { links: true, relations: { assignedTo: [] } } }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: fx.itemA.id,
            links: {},
            relations: { assignedTo: [expect.objectContaining({ id: fx.targetItem.id })] },
          }),
        ]),
      });
    }
    for (const include of [[], ["links"], { links: true }]) {
      const response = await fetch(`${baseUrl}/api/databases/${fx.database.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ include }),
      });
      expect(response.status).toBe(200);
      const legacy: unknown = await response.json();
      expect(JSON.stringify(legacy)).not.toContain('"relations"');
    }
  });

  it("expands a tenant's real person, project and area through authenticated REST under RLS", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let runtimeServer: Server | undefined;
    let failure: { error: unknown } | undefined;
    const cleanupErrors: unknown[] = [];
    try {
      const role = await runAsSystem("test:verify-runtime-role", () =>
        runtime.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
      const ownTenant = await createTestTenant(pool);
      const foreignTenant = await createTestTenant(pool);
      const passwordHash = await hashPassword(PASSWORD);
      const users = await runAsSystem("test:create-expansion-users", async () => [
        await createUser(pool, { tenantId: ownTenant, email: `${randomUUID()}@example.test`, passwordHash }),
        await createUser(pool, { tenantId: foreignTenant, email: `${randomUUID()}@example.test`, passwordHash }),
      ]);
      const cp = createChokePoint(runtime);
      async function fixture(tenantId: string) {
        return runInTenant(tenantId, async () => {
          await seedSystem(runtime, createViewTypeRegistry());
          const databases = await cp.listDatabases();
          const find = (moduleId: string) => {
            const database = databases.find((entry) => entry.ownerModuleId === moduleId);
            if (!database) throw new Error(`Missing ${moduleId} database`);
            return database;
          };
          const people = find("people");
          const projects = find("projects");
          const areas = find("areas");
          const companies = find("companies");
          const person = await cp.createItem({ databaseId: people.id, properties: { name: "Person" } });
          const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Project" } });
          const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Area" } });
          const company = await cp.createItem({ databaseId: companies.id, properties: { name: "Company" } });
          async function link(databaseId: string, callerItemId: string, key: string, targetItemId: string) {
            const property = (await cp.listProperties(databaseId)).find((entry) => entry.key === key);
            if (!property) throw new Error("Missing fixture relation");
            await cp.createRelation({ relationPropertyId: property.id, callerItemId, targetItemId });
          }
          await link(people.id, person.id, "projects", project.id);
          await link(people.id, person.id, "companies", company.id);
          await link(projects.id, project.id, "area", area.id);
          return { person, project, area, company };
        });
      }
      const own = await fixture(ownTenant);
      const foreign = await fixture(foreignTenant);
      const tokens = await Promise.all(
        users.map((user) => login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" })),
      );
      const dispatch = await createDispatcher(runtime, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      });
      runtimeServer = createServer(dispatch);
      const ownedServer = runtimeServer;
      await new Promise<void>((resolve, reject) => {
        ownedServer.once("error", reject);
        ownedServer.listen(0, "127.0.0.1", () => {
          ownedServer.off("error", reject);
          resolve();
        });
      });
      const address = ownedServer.address();
      if (!address || typeof address === "string") throw new Error("Missing REST runtime address");
      const port = address.port;
      async function fetchPerson(token: string, id: string) {
        return fetch(
          `http://127.0.0.1:${port}/api/items/${id}?include=relations&relations.projects=area&relations.companies=`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
      }
      const firstToken = tokens[0]?.token;
      const secondToken = tokens[1]?.token;
      if (!firstToken || !secondToken) throw new Error("Missing test sessions");
      for (const [token, expected] of [
        [firstToken, own],
        [secondToken, foreign],
      ] as const) {
        const response = await fetchPerson(token, expected.person.id);
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        expect(body).toMatchObject({
          id: expected.person.id,
          relations: {
            companies: [
              expect.objectContaining({
                id: expected.company.id,
                title: "Company",
                color: expect.stringMatching(/\S/),
                icon: expect.stringMatching(/\S/),
              }),
            ],
            projects: [
              expect.objectContaining({
                id: expected.project.id,
                title: "Project",
                color: expect.stringMatching(/\S/),
                icon: expect.stringMatching(/\S/),
                properties: {
                  area: [
                    expect.objectContaining({
                      id: expected.area.id,
                      title: "Area",
                      color: expect.stringMatching(/\S/),
                      icon: expect.stringMatching(/\S/),
                    }),
                  ],
                },
              }),
            ],
          },
          relationsTruncated: [],
        });
      }
      const bareFixture = await runInTenant(ownTenant, async () => {
        const source = await cp.createDatabase({ name: "Bare expansion source" });
        const target = await cp.createDatabase({ name: "Bare expansion target" });
        const caller = await cp.createItem({ databaseId: source.id, properties: {} });
        const destination = await cp.createItem({ databaseId: target.id, properties: {} });
        for (let i = 0; i < 5; i++) {
          const { property } = await cp.createRelationProperty({
            sourceDatabaseId: source.id,
            targetDatabaseId: target.id,
            key: `link${i}`,
            name: `Link ${i}`,
          });
          await cp.createRelation({
            relationPropertyId: property.id,
            callerItemId: caller.id,
            targetItemId: destination.id,
          });
        }
        return { source, target, caller, destination };
      });
      const bareUrl = `http://127.0.0.1:${port}/api/items/${bareFixture.caller.id}?include=relations`;
      const bare = await fetch(bareUrl, { headers: { Authorization: `Bearer ${firstToken}` } });
      expect(bare.status).toBe(200);
      const bareBody: unknown = await bare.json();
      expect(bareBody).toMatchObject({
        relations: Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [
            `link${i}`,
            [expect.objectContaining({ id: bareFixture.destination.id })],
          ]),
        ),
      });
      await runInTenant(ownTenant, () =>
        cp.createRelationProperty({
          sourceDatabaseId: bareFixture.source.id,
          targetDatabaseId: bareFixture.target.id,
          key: "link5",
          name: "Link 5",
        }),
      );
      const overLimit = await fetch(bareUrl, { headers: { Authorization: `Bearer ${firstToken}` } });
      expect(overLimit.status).toBe(400);
      expect(await overLimit.json()).toMatchObject({
        error: { code: "validation_failed", details: { field: "include.relations" } },
      });
      async function snapshot(tenantId: string) {
        return runInTenant(tenantId, async () => {
          const items = await runtime.query<{ id: string; properties: unknown; computed: unknown }>(
            "SELECT id, properties, computed FROM items ORDER BY id",
          );
          const edges = await runtime.query<{ id: string; item_a: string; item_b: string }>(
            "SELECT id, item_a, item_b FROM item_relations ORDER BY id",
          );
          return { items: items.rows, edges: edges.rows };
        });
      }
      const ownBefore = await snapshot(ownTenant);
      const foreignBefore = await snapshot(foreignTenant);
      const missing = randomUUID();
      const denied = await fetchPerson(secondToken, own.person.id);
      const absent = await fetchPerson(secondToken, missing);
      expect(denied.status).toBe(404);
      expect(absent.status).toBe(404);
      const deniedBody: unknown = await denied.json();
      const absentBody: unknown = await absent.json();
      expect(JSON.stringify(deniedBody).replaceAll(own.person.id, "<item>")).toBe(
        JSON.stringify(absentBody).replaceAll(missing, "<item>"),
      );
      expect(await snapshot(ownTenant)).toEqual(ownBefore);
      expect(await snapshot(foreignTenant)).toEqual(foreignBefore);
    } catch (error) {
      failure = { error };
    } finally {
      if (runtimeServer?.listening) {
        const ownedServer = runtimeServer;
        try {
          await new Promise<void>((resolve, reject) =>
            ownedServer.close((error) => (error ? reject(error) : resolve())),
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await runtime.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (failure) {
      if (cleanupErrors.length > 0) console.error("Expansion REST fixture cleanup also failed");
      throw failure.error;
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Expansion REST fixture cleanup failed");
  });

  it("has exactly one contract case per operation in the closed catalog", () => {
    expect(Object.keys(CASES).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
  });

  for (const operation of GENERIC_OPERATION_NAMES) {
    it(`dispatches ${operation} through the REST adapter`, async () => {
      const fx = await buildFixtures();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      await CASES[operation](fx, headers, baseUrl);
    });
  }

  it("ignores an actor-identity-shaped field smuggled into a POST body — REST derives the actor solely from the session (issue #220 parity)", async () => {
    const fx = await buildFixtures();
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };

    // Every REST route assembles its own explicit command object (`genericBinding.ts`'s
    // `dispatchGenericOperation`, called with a hand-picked field list, never a body spread) — an
    // `agentProjectItemId`/`runId`/`userId` field in the JSON body has no route that reads it, so
    // it cannot influence who the choke point believes made this write, unlike MCP/AgentTools'
    // `arguments`, where the same fields are rejected outright by each operation's strict schema.
    const res = await fetch(`${baseUrl}/api/databases/${fx.database.id}/views`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "table",
        name: "Stolen view",
        agentProjectItemId: randomUUID(),
        runId: randomUUID(),
        userId: randomUUID(),
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { createdBy: string; creatorProjectItemId: string | null };
    expect(body.createdBy).toBe("user");
    expect(body.creatorProjectItemId).toBeNull();
  });
});
