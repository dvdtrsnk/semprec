import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
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
import { GENERIC_OPERATION_NAMES, type GenericOperationName } from "@semprec/shared";
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
 * One REST exercise per operation in the closed 29-operation catalog (issue #219's acceptance
 * criterion: "a parameterized contract test covers all 28 operations over REST", extended to
 * `property.getByKey` by issue #432). Each case
 * issues the real HTTP request a REST caller would send and asserts only that it reaches
 * `genericApplicationService` through `GENERIC_OPERATION_BINDINGS` and succeeds — the exhaustive
 * per-field/per-error-branch behavior for each route already lives in its own handler test file
 * (`itemsHandler.test.ts`, `databasesHandler.test.ts`, `propertiesHandler.test.ts`,
 * `viewsHandler.test.ts`). The `Object.keys(CASES)` assertion below is what keeps this list
 * honest as the catalog evolves: a 30th operation with no case here fails that assertion, not
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
      body: JSON.stringify({ properties: { title: "Contract Item" } }),
    });
    expect(res.status).toBe(201);
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
  "relation.delete": async (fx, headers, baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/items/${fx.itemA.id}/relations/${fx.relationProperty.key}/${fx.targetItem.id}`,
      { method: "DELETE", headers },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { itemA: string; itemB: string };
    expect([body.itemA, body.itemB]).toContain(fx.itemA.id);
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
    await pool?.end();
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
