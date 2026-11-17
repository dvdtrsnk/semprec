import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Pool, type PoolClient } from "pg";
import { z } from "zod";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  getTenantZeroId,
  resetDatabase,
  tenantForNextTestUser,
  registerRelationEdgeChangedHook,
  clearHooksForTests,
  ensureMailAccountSyncState,
  reconcileGmailAccount,
  type GmailMailClient,
  type RelationEdgeChangedHookContext,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createCoreTaskList,
  createLibraryMetadataFetcher,
  createItemWithClient,
  createDocStore,
  getDatabaseByModuleId,
  getOrCreateJournalItem,
  createUser,
  createViewTypeRegistry,
  ensureItemAutomation,
  hashPassword,
  insertValueLink,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  resolveMailModuleIds,
  seedSystem,
  withTransaction,
  type ChokePoint,
  type ItemRow,
  type PasswordResetMailer,
  type PropertyRow,
  type ViewRow,
} from "@semprec/data";
import { createGenericApplicationService } from "@semprec/application";
import { GENERIC_OPERATION_NAMES, runAsSystem, runInTenant, type GenericOperationName } from "@semprec/shared";
import { CORE_TASK_NAMES, enqueueJob, runOnce } from "@semprec/queue";
import { dispatchGenericOperation, restActor } from "../adapter/genericBinding.js";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const LIBRARY_TASK = CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS;

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry = await loadFullModuleRegistry();

/** Sends a request to the REST server; a non-string body is JSON-encoded, a string is sent as is. */
type Api = (path: string, method?: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;

function makeApi(baseUrl: string, headers: Record<string, string>): Api {
  return (path, method = "GET", body, extra) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
    });
}

/** Asserts the response status and returns its JSON body. */
async function read(response: Promise<Response>, status = 200): Promise<unknown> {
  const res = await response;
  expect(res.status).toBe(status);
  return res.json();
}

const withId = z.object({ id: z.string() }).passthrough();
const validationFailed = (field: string) => ({ error: { code: "validation_failed", details: { field } } });

async function startServer(dbPool: Pool): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(
    await createDispatcher(dbPool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

async function jsonAuthHeaders(): Promise<Record<string, string>> {
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/** A foreign id and an absent id must answer with the same status, headers and body (ids masked). */
async function expectSameRefusal(
  foreign: Response,
  random: Response,
  foreignId: string,
  randomId: string,
): Promise<number> {
  expect(random.status).toBe(foreign.status);
  expect(foreign.status).toBeGreaterThanOrEqual(400);
  for (const header of ["content-type", "cache-control", "vary"])
    expect(foreign.headers.get(header)).toBe(random.headers.get(header));
  expect((await foreign.text()).replaceAll(foreignId, "<id>")).toBe((await random.text()).replaceAll(randomId, "<id>"));
  return foreign.status;
}

interface RuntimeRest<F> {
  runtime: Pool;
  cp: ChokePoint;
  tenants: readonly [string, string];
  own: F;
  foreign: F;
  tokens: readonly [string, string];
  as: (token: string | null) => Api;
  defer: (cleanup: () => Promise<void>) => void;
}

/**
 * Runs `body` against a REST server on the non-superuser `semprec_data` runtime pool, with two freshly seeded
 * tenants (fixture built in each) and one logged-in user per tenant. Cleans up and aggregates every failure.
 */
async function withRuntimeRest<F>(
  fixture: (cp: ChokePoint, runtime: Pool, tenantId: string) => Promise<F>,
  body: (ctx: RuntimeRest<F>) => Promise<void>,
): Promise<void> {
  const runtime = await createRuntimeRolePool(pool, "semprec_data");
  const cleanups: (() => Promise<void>)[] = [() => runtime.end()];
  const errors: unknown[] = [];
  try {
    const role = await runAsSystem("test:runtime-role", () =>
      runtime.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
    const tenants = [await createTestTenant(pool), await createTestTenant(pool)] as const;
    const passwordHash = await hashPassword(PASSWORD);
    const users = await runAsSystem("test:runtime-users", () =>
      Promise.all(
        tenants.map((tenantId) => createUser(pool, { tenantId, email: `${randomUUID()}@example.test`, passwordHash })),
      ),
    );
    const cp = createChokePoint(runtime);
    const seed = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        await seedSystem(runtime, createViewTypeRegistry());
        return fixture(cp, runtime, tenantId);
      });
    const own = await seed(tenants[0]);
    const foreign = await seed(tenants[1]);
    const [ownSession, foreignSession] = await Promise.all(
      users.map((user) => login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" })),
    );
    if (!ownSession || !foreignSession) throw new Error("Missing test sessions");
    const { server, baseUrl } = await startServer(runtime);
    cleanups.unshift(() => closeServer(server));
    await body({
      runtime,
      cp,
      tenants,
      own,
      foreign,
      tokens: [ownSession.token, foreignSession.token],
      as: (token) =>
        makeApi(baseUrl, {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        }),
      defer: (cleanup) => cleanups.push(cleanup),
    });
  } catch (error) {
    errors.push(error);
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Runtime REST test and cleanup failed");
}

const findDatabase = async (cp: ChokePoint, moduleId: string) => {
  const database = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === moduleId);
  if (!database) throw new Error(`Missing ${moduleId} database`);
  return database;
};

const findProperty = async (cp: ChokePoint, databaseId: string, key: string) => {
  const property = (await cp.listProperties(databaseId)).find((entry) => entry.key === key);
  if (!property) throw new Error(`Missing ${key} property`);
  return property;
};

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

const createTags = (fx: Fixtures) =>
  chokePoint.createProperty({
    databaseId: fx.database.id,
    key: "tags",
    name: "Tags",
    type: "multi_select",
    config: { options: [{ key: "herbs", label: "Herbs" }] },
  });

const createSinglePage = async (fx: Fixtures, title?: string) => {
  const page = (await createDocStore(pool).createSubpage({ parent: { itemId: fx.itemA.id }, title }, "user")).pages[0];
  if (!page) throw new Error("Missing page");
  return page;
};

const titleLink = (fx: Fixtures, broken: boolean) =>
  withTransaction(pool, (client) =>
    insertValueLink(client, {
      itemId: fx.itemA.id,
      propertyKey: "title",
      ruleKey: "test",
      ...(broken ? { state: "broken" as const, brokenBy: "user" as const, brokenAt: new Date() } : {}),
      sources: [{ kind: "item", sourceItemId: fx.itemB.id, sourcePropertyKey: "title" }],
    }),
  );

type ContractCase = (fx: Fixtures, api: Api) => Promise<void>;

/**
 * One REST exercise per operation in the closed catalog, asserting that the real HTTP request reaches
 * `genericApplicationService` through `GENERIC_OPERATION_BINDINGS` and succeeds; per-branch behavior lives in each
 * route's handler test. The `Object.keys(CASES)` assertion below fails for an operation with no case.
 */
const CASES: Record<GenericOperationName, ContractCase> = {
  "database.list": async (fx, api) => {
    const body = z.object({ databases: z.array(withId) }).parse(await read(api("/api/databases")));
    expect(body.databases.some((d) => d.id === fx.database.id)).toBe(true);
  },
  "database.get": async (fx, api) => {
    expect(await read(api(`/api/databases/${fx.database.id}`))).toMatchObject({ id: fx.database.id });
  },
  "database.create": async (_fx, api) => {
    await read(api("/api/databases", "POST", { name: "Contract Create" }), 201);
  },
  "database.patch": async (fx, api) => {
    const patched = await read(api(`/api/databases/${fx.database.id}`, "PATCH", { name: "Renamed" }));
    expect(patched).toMatchObject({ name: "Renamed" });
  },
  "database.archive": async (fx, api) => {
    expect((await api(`/api/databases/${fx.database.id}`, "DELETE")).status).toBe(200);
  },
  "database.restore": async (fx, api) => {
    await api(`/api/databases/${fx.database.id}`, "DELETE");
    expect((await api(`/api/databases/${fx.database.id}/restore`, "POST")).status).toBe(200);
  },
  "database.query": async (fx, api) => {
    expect((await api(`/api/databases/${fx.database.id}/query`, "POST", "{}")).status).toBe(200);
  },
  "database.facets": async (fx, api) => {
    const body = await read(
      api(`/api/databases/${fx.database.id}/facets`, "POST", {
        facets: [fx.relationProperty.key, fx.property.key],
        extra: { open: { type: "equals", property: fx.property.key, value: "Dune" } },
      }),
    );
    expect(body).toEqual({
      facets: [
        {
          property: fx.relationProperty.key,
          all: 2,
          open: 1,
          values: [
            { value: fx.targetItem.id, label: "", count: 1 },
            { value: null, count: 1 },
          ],
        },
        {
          property: fx.property.key,
          all: 2,
          open: 1,
          values: [
            { value: "Arrival", count: 1 },
            { value: "Dune", count: 1 },
          ],
        },
      ],
    });
  },
  // The raw rows, not the localized catalog projection: `config` proves it wasn't stripped.
  "property.list": async (fx, api) => {
    const body = z
      .object({ properties: z.array(withId) })
      .parse(await read(api(`/api/properties?databaseId=${fx.database.id}`)));
    expect(body.properties.find((p) => p.id === fx.property.id)).toMatchObject({ config: expect.any(Object) });
  },
  "property.get": async (fx, api) => {
    const body = await read(api(`/api/properties/${fx.property.id}`));
    expect(body).toMatchObject({ id: fx.property.id, config: expect.any(Object) });
  },
  // REST exposes `property.getByKey` only through the relation routes' `:propertyKey`: a RELATION key resolves, a
  // same-database non-relation key is filtered out by `type` and answers 404.
  "property.getByKey": async (fx, api) => {
    const put = (key: string) => api(`/api/items/${fx.itemB.id}/relations/${key}/${fx.targetItem.id}`, "PUT", "{}");
    expect((await put(fx.relationProperty.key)).status).toBe(200);
    expect((await put(fx.property.key)).status).toBe(404);
  },
  "property.create": async (fx, api) => {
    const create = (body: unknown) => api(`/api/databases/${fx.database.id}/properties`, "POST", body);
    const select = (key: string, color: unknown) => ({
      key,
      name: key,
      type: "select",
      config: { options: [{ key: "one", color }] },
    });
    await read(create({ key: "score", name: "Score", type: "number" }), 201);
    expect(await read(create(select("colorChoice", "#ff3b30")), 201)).toMatchObject({
      config: { options: [{ key: "one", color: "#FF3B30" }] },
    });
    for (const invalid of ["red", "#FFF", "#GGGGGG", 1])
      expect(await read(create(select("badColor", invalid)), 400)).toMatchObject(validationFailed("config"));
  },
  "property.patch": async (fx, api) => {
    const renamed = await read(api(`/api/properties/${fx.property.id}`, "PATCH", { name: "New Title" }));
    expect(renamed).toMatchObject({ name: "New Title" });
    const { id } = withId.parse(
      await read(
        api(`/api/databases/${fx.database.id}/properties`, "POST", {
          key: "patchColor",
          name: "Patch color",
          type: "select",
          config: { options: [{ key: "one" }] },
        }),
        201,
      ),
    );
    const patch = (color: unknown) =>
      api(`/api/properties/${id}`, "PATCH", { config: { options: [{ key: "one", color }] } });
    expect(await read(patch("#ff3b30"))).toMatchObject({ config: { options: [{ key: "one", color: "#FF3B30" }] } });
    expect(await read(patch("red"), 400)).toMatchObject(validationFailed("config"));
  },
  "property.option.add": async (fx, api) => {
    const tags = await createTags(fx);
    const added = await read(
      api(`/api/properties/${tags.id}/options`, "POST", { label: "Spices", color: "#34c759" }),
      201,
    );
    expect(added).toEqual({ key: "spices", label: "Spices", color: "#34C759" });
    expect((await chokePoint.getProperty(tags.id))?.config.options).toEqual([
      { key: "herbs", label: "Herbs" },
      { key: "spices", label: "Spices", color: "#34C759" },
    ]);
  },
  "property.option.update": async (fx, api) => {
    const tags = await createTags(fx);
    const updated = await read(api(`/api/properties/${tags.id}/options/herbs`, "PATCH", { label: "Fresh herbs" }));
    expect(updated).toEqual({ key: "herbs", label: "Fresh herbs" });
    expect((await chokePoint.getProperty(tags.id))?.config.options).toEqual([{ key: "herbs", label: "Fresh herbs" }]);
  },
  "property.delete": async (fx, api) => {
    const scratch = await chokePoint.createProperty({
      databaseId: fx.database.id,
      key: "scratch",
      name: "Scratch",
      type: "text",
    });
    expect(await read(api(`/api/properties/${scratch.id}`, "DELETE"))).toEqual(scratch);
  },
  "view.list": async (fx, api) => {
    const body = z.object({ views: z.array(withId) }).parse(await read(api("/api/views")));
    expect(body.views.some((v) => v.id === fx.curatedView.id)).toBe(true);
  },
  "view.get": async (fx, api) => {
    expect(await read(api(`/api/views/${fx.curatedView.id}`))).toMatchObject({ id: fx.curatedView.id });
  },
  "view.create": async (fx, api) => {
    await read(api(`/api/databases/${fx.database.id}/views`, "POST", { type: "table", name: "All rows" }), 201);
  },
  "view.patch": async (fx, api) => {
    const patched = await read(api(`/api/views/${fx.curatedView.id}`, "PATCH", { name: "Renamed view" }));
    expect(patched).toMatchObject({ name: "Renamed view" });
  },
  "view.delete": async (_fx, api) => {
    const scratch = await chokePoint.createView({ type: "list", name: "Scratch", config: { membership: "manual" } });
    expect(await read(api(`/api/views/${scratch.id}`, "DELETE"))).toEqual(scratch);
  },
  "view.query": async (fx, api) => {
    expect((await api(`/api/views/${fx.curatedView.id}/query`, "POST", "{}")).status).toBe(200);
  },
  "viewItem.add": async (fx, api) => {
    expect((await api(`/api/views/${fx.curatedView.id}/items/${fx.itemB.id}`, "PUT", { position: 1 })).status).toBe(
      200,
    );
  },
  "viewItem.remove": async (fx, api) => {
    expect((await api(`/api/views/${fx.curatedView.id}/items/${fx.itemA.id}`, "DELETE")).status).toBe(200);
  },
  "viewItem.reorder": async (fx, api) => {
    await chokePoint.addViewItem({
      viewId: fx.curatedView.id,
      itemId: fx.itemB.id,
      position: 1,
      actor: { type: "user" },
    });
    const moved = await read(api(`/api/views/${fx.curatedView.id}/items/${fx.itemB.id}`, "PATCH", { position: 0 }));
    expect(moved).toMatchObject({ position: 0 });
  },
  "item.get": async (fx, api) => {
    expect(await read(api(`/api/items/${fx.itemA.id}`))).toMatchObject({ id: fx.itemA.id });
  },
  "item.create": async (fx, api) => {
    const created = await read(
      api(`/api/databases/${fx.database.id}/items`, "POST", {
        properties: { title: "Contract Item" },
        relations: [{ propertyKey: fx.relationProperty.key, targetItemIds: [fx.targetItem.id] }],
      }),
      201,
    );
    expect(created).toMatchObject({ properties: { title: "Contract Item" } });
  },
  "item.patch": async (fx, api) => {
    const patched = await read(
      api(`/api/items/${fx.itemA.id}`, "PATCH", { properties: { title: "Updated" }, ifVersion: fx.itemA.version }),
    );
    expect(patched).toMatchObject({ properties: { title: "Updated" } });
  },
  "item.delete": async (fx, api) => {
    expect((await api(`/api/items/${fx.itemB.id}`, "DELETE")).status).toBe(200);
  },
  "item.restore": async (fx, api) => {
    await api(`/api/items/${fx.itemB.id}`, "DELETE");
    expect((await api(`/api/items/${fx.itemB.id}/restore`, "POST")).status).toBe(200);
  },
  "item.count": async (fx, api) => {
    const body = await read(
      api("/api/items/count", "POST", {
        items: [{ databaseId: fx.database.id, groupBy: fx.relationProperty.key }, { databaseId: fx.targetDatabase.id }],
      }),
    );
    expect(body).toEqual({
      counts: [
        {
          databaseId: fx.database.id,
          count: 2,
          groups: [
            { key: fx.targetItem.id, count: 1 },
            { key: null, count: 1 },
          ],
        },
        { databaseId: fx.targetDatabase.id, count: 1 },
      ],
    });
  },
  "relation.put": async (fx, api) => {
    const edge = await read(
      api(`/api/items/${fx.itemB.id}/relations/${fx.relationProperty.key}/${fx.targetItem.id}`, "PUT", {
        metadata: { role: "tester" },
      }),
    );
    expect(edge).toMatchObject({ itemA: fx.itemB.id, itemB: fx.targetItem.id });
  },
  // Sets, repeats, clears (twice) and rejects a multi-valued relation key.
  "relation.set": async (fx, api) => {
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: fx.database.id,
      key: "singleTarget",
      name: "Single target",
      targetDatabaseId: fx.targetDatabase.id,
      cardinality: "one_to_one",
    });
    const set = (key: string, targetItemId: string | null) =>
      api(`/api/items/${fx.itemB.id}/relations/${key}`, "PUT", { targetItemId });
    const edge = await read(set(property.key, fx.targetItem.id));
    expect(edge).toMatchObject({ itemA: fx.itemB.id, itemB: fx.targetItem.id });
    expect(await read(set(property.key, fx.targetItem.id))).toEqual(edge);
    expect(await read(set(fx.relationProperty.key, fx.targetItem.id), 400)).toMatchObject(
      validationFailed("propertyKey"),
    );
    expect(await read(set(property.key, null))).toEqual({ deleted: true });
    expect((await set(property.key, null)).status).toBe(200);
  },
  // The deletion also reports the changed edge to the relation hook.
  "relation.delete": async (fx, api) => {
    const calls: RelationEdgeChangedHookContext[] = [];
    registerRelationEdgeChangedHook(async (context) => {
      calls.push(context);
    });
    const path = `/api/items/${fx.itemA.id}/relations/${fx.relationProperty.key}/${fx.targetItem.id}`;
    expect(await read(api(path, "DELETE"))).toMatchObject({ itemA: fx.itemA.id, itemB: fx.targetItem.id });
    expect(calls).toEqual([
      expect.objectContaining({
        op: "delete",
        propertyId: fx.relationProperty.id,
        itemA: fx.itemA.id,
        itemB: fx.targetItem.id,
        writer: expect.objectContaining({ writerKind: "user" }),
      }),
    ]);
  },
  "relation.list": async (fx, api) => {
    const body = z
      .object({ relations: z.array(z.object({ targetItemId: z.string() }).passthrough()) })
      .parse(await read(api(`/api/items/${fx.itemA.id}/relations`)));
    expect(body.relations.map((relation) => relation.targetItemId)).toEqual([fx.targetItem.id]);
  },
  "relation.related": async (fx, api) => {
    expect(await read(api(`/api/items/${fx.itemA.id}/related`))).toEqual([
      {
        databaseKey: null,
        databaseId: fx.targetDatabase.id,
        count: 1,
        via: "direct",
        filter: { type: "relation_contains", property: "assignedFrom", value: fx.itemA.id },
      },
    ]);
  },
  "link.unlink": async (fx, api) => {
    await titleLink(fx, false);
    const unlinked = await read(api(`/api/items/${fx.itemA.id}/links/title/unlink`, "POST"));
    expect(unlinked).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
  },
  "link.relink": async (fx, api) => {
    await titleLink(fx, true);
    expect(await read(api(`/api/items/${fx.itemA.id}/links/title/relink`, "POST"))).toMatchObject({
      valueKind: "inherited",
    });
    expect((await chokePoint.getItem(fx.database.id, fx.itemA.id))?.properties.title).toBe(fx.itemB.properties.title);
  },
  "page.get": async (fx, api) => {
    expect(await read(api(`/api/items/${fx.itemA.id}/page`))).toMatchObject({
      docId: null,
      blocks: [],
      blockCount: 0,
      subpageCount: 0,
    });
  },
  "page.ensure": async (fx, api) => {
    const { docId } = z
      .object({ docId: z.string() })
      .passthrough()
      .parse(await read(api(`/api/items/${fx.itemA.id}/page`, "PUT")));
    expect(await read(api(`/api/items/${fx.itemA.id}/page`))).toMatchObject({ docId });
  },
  // Its REST equivalent is the lazy-creating route.
  "page.ensureJournalPeriod": async (_fx, api) => {
    expect(await read(api("/api/journal/periods/week/2026-W42/doc", "PUT"))).toMatchObject({
      itemId: expect.any(String),
      docId: expect.any(String),
      period: "2026-W42",
      range: { from: "2026-10-12", to: "2026-10-18" },
    });
  },
  // No REST route: the case dispatches the binding as a person's REST session would, over a period with two live
  // entries.
  "page.mergeJournalDuplicates": async () => {
    const journal = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "journal"));
    if (!journal) throw new Error("Journal database is not seeded");
    // The lazy creation never produces this state, so the fixture creates both entries directly.
    const entry = () =>
      withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: journal.id, properties: { name: "\u{1F4D3} 2026-10-16", type: "day", period: "2026-10-16" } },
          { allowedSystemKeys: ["name", "type", "period"] },
        ),
      );
    const survivor = await entry();
    const duplicate = await entry();
    const service = createGenericApplicationService(pool, {
      resolve: () => ({
        icon: null,
        color: null,
        overviewOrder: null,
        switcherOrder: null,
        clientVisible: true,
        overviewHidden: false,
      }),
      collectionFilter: () => undefined,
      overviewHideable: () => false,
    });
    const merged = await dispatchGenericOperation(service, "page.mergeJournalDuplicates", restActor(randomUUID()), {
      type: "day",
      period: "2026-10-16",
    });
    expect(merged).toEqual({ survivorId: survivor.id, mergedItemId: duplicate.id });
    expect((await chokePoint.findItemIncludingDeleted(duplicate.id))?.deletedAt).not.toBeNull();
    expect(await chokePoint.findItem(survivor.id)).not.toBeNull();
  },
  "page.createSubpage": async (fx, api) => {
    const created = z
      .object({
        pages: z.array(z.object({ pageItemId: z.string(), docId: z.string(), blockId: z.string() }).strict()).length(1),
      })
      .strict()
      .parse(await read(api(`/api/items/${fx.itemA.id}/page/subpages`, "POST", { title: "Release checklist" }), 201));
    const [page] = created.pages;
    expect(await read(api(`/api/items/${fx.itemA.id}/page`))).toMatchObject({
      subpageCount: 1,
      blocks: [{ id: page?.blockId, type: "page", pageId: page?.pageItemId, text: "Release checklist" }],
    });
  },
  "page.duplicate": async (fx, api) => {
    const original = await createSinglePage(fx);
    const copy = z
      .object({ pageItemId: z.string(), docId: z.string(), blockId: z.string() })
      .strict()
      .parse(await read(api(`/api/items/${original.pageItemId}/page/duplicate`, "POST"), 201));
    expect(await read(api(`/api/items/${fx.itemA.id}/page`))).toMatchObject({
      subpageCount: 2,
      blocks: [
        { id: original.blockId, type: "page", pageId: original.pageItemId },
        { id: copy.blockId, type: "page", pageId: copy.pageItemId },
      ],
    });
  },
  "page.rename": async (fx, api) => {
    const page = await createSinglePage(fx, "Before");
    const renamed = await read(api(`/api/items/${page.pageItemId}/page/title`, "PATCH", { title: "After" }));
    expect(renamed).toEqual({ pageItemId: page.pageItemId, title: "After" });
    expect(await read(api(`/api/items/${fx.itemA.id}/page`))).toMatchObject({
      blocks: [{ id: page.blockId, type: "page", pageId: page.pageItemId, text: "After" }],
    });
  },
  "page.convertToBlock": async (fx, api) => {
    const page = await createSinglePage(fx, "Before");
    const converted = z
      .object({ blockId: z.string(), trashedPageCount: z.literal(1) })
      .strict()
      .parse(
        await read(
          api(`/api/items/${fx.itemA.id}/page/convert`, "POST", {
            blockId: page.blockId,
            type: "h2",
            confirmedPageCount: 1,
          }),
        ),
      );
    // The page block was the only block, so the trash left the empty text block of an emptied document.
    expect(await read(api(`/api/items/${fx.itemA.id}/page`))).toMatchObject({
      blocks: [
        { id: converted.blockId, type: "h2", text: "Before" },
        { type: "text", text: "" },
      ],
    });
  },
  "page.insert": async (fx, api) => {
    const inserted = z
      .object({ blockIds: z.array(z.string()).length(2) })
      .strict()
      .parse(
        await read(
          api(`/api/items/${fx.itemA.id}/page/insert`, "POST", {
            placement: "end",
            markdown: "First line\n\nSecond line",
          }),
        ),
      );
    expect(await read(api(`/api/items/${fx.itemA.id}/page`))).toMatchObject({
      blockCount: 2,
      blocks: [
        { id: inserted.blockIds[0], text: "First line" },
        { id: inserted.blockIds[1], text: "Second line" },
      ],
    });
  },
  "page.replace": async (fx, api) => {
    // Without a document, the page has an empty document's version token; replacing it creates the page.
    const etag = (await api(`/api/items/${fx.itemA.id}/page.md`)).headers.get("etag");
    expect(etag).not.toBeNull();
    const replaced = await read(
      api(`/api/items/${fx.itemA.id}/page.md`, "PUT", "Replaced line", {
        "Content-Type": "text/markdown",
        "If-Match": etag ?? "",
      }),
    );
    expect(replaced).toEqual({ trashedPages: [] });
    expect(await read(api(`/api/items/${fx.itemA.id}/page`))).toMatchObject({
      blockCount: 1,
      blocks: [{ text: "Replaced line" }],
    });
  },
  "page.changes": async (fx, api) => {
    const since = encodeURIComponent(new Date(Date.now() - 60 * 1000).toISOString());
    expect(await read(api(`/api/items/${fx.itemA.id}/page/changes?since=${since}`))).toEqual([]);
  },
  "page.restoreVersion": async (fx, api) => {
    await createDocStore(pool).putBlock(
      fx.itemA.id,
      { id: "b1", flavour: "paragraph", fields: { content: "first" } },
      "user",
    );
    // Backdates the document's history so a restore point half an hour ago exists.
    const docOf = "doc_id = (SELECT id FROM docs WHERE item_id = $1)";
    for (const sql of [
      `UPDATE docs SET history_available_from = now() - interval '1 hour' WHERE item_id = $1`,
      `UPDATE doc_snapshot_history SET represented_at = now() - interval '1 hour' WHERE through_update_id = 0 AND ${docOf}`,
      `UPDATE doc_updates SET created_at = now() - interval '1 hour' WHERE ${docOf}`,
      `UPDATE doc_history_updates SET created_at = now() - interval '1 hour' WHERE ${docOf}`,
    ])
      await pool.query(sql, [fx.itemA.id]);
    const restored = await read(
      api(`/api/items/${fx.itemA.id}/page/restore`, "POST", {
        at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      }),
    );
    expect(restored).toMatchObject({ itemId: fx.itemA.id, blockIds: ["b1"] });
  },
  search: async (_fx, api) => {
    const tasks = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "tasks"));
    const journal = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "journal"));
    if (!tasks || !journal) throw new Error("Tasks or Journal not seeded");
    const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { name: "Contract search task" } });
    expect(await read(api("/api/search?q=contract%20search&scope=task,event&perGroupLimit=2"))).toEqual({
      groups: [
        {
          type: "task",
          total: 1,
          items: [
            {
              itemId: task.id,
              databaseId: tasks.id,
              databaseKey: "tasks",
              title: "Contract search task",
              subtitleParts: [],
              snippet: null,
            },
          ],
          nextCursor: null,
        },
      ],
    });

    // A journal result carries the stored period type and key; other groups none.
    const journalItem = (type: "day" | "week") =>
      withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, journal.id, type, new Date("2026-10-16T12:00:00Z"), "UTC"),
      );
    const day = await journalItem("day");
    const week = await journalItem("week");
    const dated = await chokePoint.createItem({ databaseId: tasks.id, properties: { name: "Contract task 2026" } });
    const byId = new Map(
      z
        .object({
          groups: z.array(
            z.object({ type: z.string(), items: z.array(z.object({ itemId: z.string() }).passthrough()) }),
          ),
        })
        .parse(await read(api("/api/search?q=2026&scope=task,journal")))
        .groups.flatMap((group) => group.items.map((item) => [item.itemId, { group: group.type, item }] as const)),
    );
    expect(byId.get(day.id)).toEqual({
      group: "journal",
      item: expect.objectContaining({ journal: { type: "day", period: "2026-10-16" } }),
    });
    expect(byId.get(week.id)).toEqual({
      group: "journal",
      item: expect.objectContaining({ journal: { type: "week", period: "2026-W42" } }),
    });
    expect(byId.get(dated.id)?.group).toBe("task");
    expect(byId.get(dated.id)?.item).not.toHaveProperty("journal");
  },
};

const enqueueLibraryMetadata = (dbPool: Pool, itemId: string, databaseId: string) =>
  withTransaction(dbPool, (client) =>
    enqueueJob(
      client,
      LIBRARY_TASK,
      { itemId, databaseId, config: { source: "openLibrary", coverKey: "cover" } },
      { jobKey: `library-metadata:${itemId}`, maxAttempts: 3 },
    ),
  );

async function runLibraryTask(dbPool: Pool, fetchImpl: (url: string) => Promise<Response>): Promise<void> {
  const task = createCoreTaskList(dbPool, new Map(), createLibraryMetadataFetcher({ fetch: fetchImpl }))[LIBRARY_TASK];
  if (!task) throw new Error("Library task missing");
  await runOnce({ pgPool: dbPool, taskList: { [LIBRARY_TASK]: task } });
}

describe("generic operation REST contract", () => {
  let server: Server;
  let api: Api;

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const started = await startServer(pool);
    server = started.server;
    api = makeApi(started.baseUrl, await jsonAuthHeaders());
  });

  afterEach(() => closeServer(server));

  afterAll(async () => {
    clearHooksForTests();
    await pool?.end();
  });

  it("has exactly one contract case per operation in the closed catalog", () => {
    expect(Object.keys(CASES).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
  });

  it.each([...GENERIC_OPERATION_NAMES])("dispatches %s through the REST adapter", async (operation) => {
    await CASES[operation](await buildFixtures(), api);
  });

  it("unlinks a file's inherited project over REST and preserves break metadata on repeat", async () => {
    const files = await chokePoint.createDatabase({ name: "Files" });
    const projects = await chokePoint.createDatabase({ name: "Projects" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: files.id,
      targetDatabaseId: projects.id,
      key: "projects",
      name: "Projects",
      cardinality: "many_to_many",
    });
    const source = await chokePoint.createItem({ databaseId: files.id, properties: {} });
    const file = await chokePoint.createItem({ databaseId: files.id, properties: {} });
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    for (const item of [source, file])
      await chokePoint.createRelation({
        relationPropertyId: property.id,
        callerItemId: item.id,
        targetItemId: project.id,
      });
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: file.id,
        propertyKey: "projects",
        ruleKey: "test",
        sources: [{ kind: "item", sourceItemId: source.id, sourcePropertyKey: "projects" }],
      }),
    );
    const unlink = () => read(api(`/api/items/${file.id}/links/projects/unlink`, "POST"));
    const first = await unlink();
    expect(first).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user", brokenAt: expect.any(String) });
    const edges = await chokePoint.listItemRelations(file.id, property.id);
    expect(edges?.map((edge) => edge.targetItemId)).toEqual([project.id]);
    expect(await unlink()).toEqual(first);
  });

  it("returns link conflicts over REST without changing the target or link", async () => {
    const fx = await buildFixtures();
    const beforeItem = await chokePoint.getItem(fx.database.id, fx.itemA.id);
    const expectConflict = async () => {
      const links = await chokePoint.getValueLinksForItems([fx.itemA.id]);
      expect(await read(api(`/api/items/${fx.itemA.id}/links/title/relink`, "POST"), 409)).toMatchObject({
        error: { code: "value_link_conflict" },
      });
      expect(await chokePoint.getItem(fx.database.id, fx.itemA.id)).toEqual(beforeItem);
      expect(await chokePoint.getValueLinksForItems([fx.itemA.id])).toEqual(links);
    };
    await expectConflict(); // no link at all

    const other = await chokePoint.createItem({ databaseId: fx.database.id, properties: { title: "Other" } });
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: fx.itemA.id,
        propertyKey: "title",
        ruleKey: "test",
        state: "broken",
        brokenBy: "user",
        brokenAt: new Date(),
        sources: [fx.itemB, other].map((item) => ({
          kind: "item" as const,
          sourceItemId: item.id,
          sourcePropertyKey: "title",
        })),
      }),
    );
    await expectConflict(); // more sources than the single-valued target accepts

    await chokePoint.softDeleteItem(fx.database.id, fx.itemB.id);
    await chokePoint.softDeleteItem(fx.database.id, other.id);
    await expectConflict(); // no live source
  });

  it("filters the system area from database.query and refuses its deletion", async () => {
    const areas = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
    if (!areas) throw new Error("Areas missing");
    const system = (await chokePoint.listItems(areas.id)).items.find((item) => item.properties.systemActive === true);
    if (!system) throw new Error("System area missing");
    const user = await chokePoint.createItem({ databaseId: areas.id, properties: { name: "User area" } });
    expect(await read(api(`/api/items/${system.id}`, "DELETE"), 403)).toMatchObject({
      error: { details: { field: "systemActive" } },
    });
    const result = await read(
      api(`/api/databases/${areas.id}/query`, "POST", { filter: { type: "is_empty", property: "systemActive" } }),
    );
    expect(result).toMatchObject({ items: [expect.objectContaining({ id: user.id })] });
    expect(JSON.stringify(result)).not.toContain(system.id);
    expect(await chokePoint.getItem(areas.id, system.id)).toEqual(system);
  });

  it("rejects nonempty and non-object item DELETE bodies before dispatch", async () => {
    const fx = await buildFixtures();
    for (const body of [{ reason: "private reason" }, { unexpected: true }, []]) {
      expect(await read(api(`/api/items/${fx.itemA.id}`, "DELETE", body), 400)).toMatchObject({
        error: { code: "validation_failed" },
      });
      expect((await api(`/api/items/${fx.itemA.id}`)).status).toBe(200);
    }
    expect((await api(`/api/items/${fx.itemB.id}`, "DELETE", "{}")).status).toBe(200);
    expect((await api(`/api/items/${fx.itemA.id}`, "DELETE")).status).toBe(200);
  });

  it("returns the same expansion on item, database and view reads while retaining path and links", async () => {
    const fx = await buildFixtures();
    const item = await read(api(`/api/items/${fx.itemA.id}?include=path,links,relations&relations.assignedTo=`));
    expect(item).toMatchObject({
      links: {},
      relations: { assignedTo: [{ id: fx.targetItem.id, icon: "database", color: "#FF9500" }] },
      relationsTruncated: [],
    });
    expect(item).toHaveProperty("path");
    for (const path of [`/api/databases/${fx.database.id}/query`, `/api/views/${fx.curatedView.id}/query`]) {
      expect(await read(api(path, "POST", { include: { links: true, relations: { assignedTo: [] } } }))).toMatchObject({
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
      const legacy = await read(api(`/api/databases/${fx.database.id}/query`, "POST", { include }));
      expect(JSON.stringify(legacy)).not.toContain('"relations"');
    }
  });

  it("exposes automation only when requested on the three generic reads", async () => {
    const fx = await buildFixtures();
    await withTransaction(pool, (client) => ensureItemAutomation(client, fx.itemA.id));
    const bare = await api(`/api/items/${fx.itemA.id}`);
    expect(bare.status).toBe(200);
    expect(await bare.text()).toBe(await (await api(`/api/items/${fx.itemA.id}?include=`)).text());
    expect(await read(api(`/api/items/${fx.itemA.id}?include=automation`))).toMatchObject({
      id: fx.itemA.id,
      automation: {
        status: "pending",
        attempts: 0,
        lastAttemptAt: null,
        nextAttemptAt: null,
        source: null,
        errorCode: null,
      },
    });
    expect(await read(api(`/api/items/${fx.itemB.id}?include=automation`))).not.toHaveProperty("automation");
    for (const path of [`/api/databases/${fx.database.id}/query`, `/api/views/${fx.curatedView.id}/query`]) {
      expect(await read(api(path, "POST", { include: ["automation"] }))).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ id: fx.itemA.id, automation: expect.objectContaining({ status: "pending" }) }),
        ]),
      });
    }
    await runInTenant(getTenantZeroId(), async () => {
      await chokePoint.createProperty({ databaseId: fx.database.id, key: "name", name: "Name", type: "text" });
      await chokePoint.updateItem({
        databaseId: fx.database.id,
        itemId: fx.itemA.id,
        propertiesPatch: { name: "Arrival" },
      });
      await enqueueLibraryMetadata(pool, fx.itemA.id, fx.database.id);
    });
    let providerCalls = 0;
    await runLibraryTask(pool, async () => {
      providerCalls++;
      return new Response("secret-provider-response", { status: 503 });
    });
    expect(providerCalls).toBe(2);
    const failed = await api(`/api/items/${fx.itemA.id}?include=automation`);
    expect(failed.status).toBe(200);
    const failedText = await failed.text();
    expect(failedText).not.toContain("secret-provider-response");
    expect(JSON.parse(failedText)).toMatchObject({
      automation: { status: "error", errorCode: "sourceUnavailable", attempts: 1, source: "googleBooks" },
    });
  });

  it("ignores actor-identity fields smuggled into a POST body: REST derives the actor solely from the session", async () => {
    const fx = await buildFixtures();
    // Every REST route assembles an explicit command object from hand-picked fields, never a body spread, so
    // `agentProjectItemId`/`runId`/`userId` in the JSON body cannot influence the write's actor.
    const view = await read(
      api(`/api/databases/${fx.database.id}/views`, "POST", {
        type: "table",
        name: "Stolen view",
        agentProjectItemId: randomUUID(),
        runId: randomUUID(),
        userId: randomUUID(),
      }),
      201,
    );
    expect(view).toMatchObject({ createdBy: "user", creatorProjectItemId: null });
  });

  it("keeps automation includes tenant-scoped on the real REST runtime pool", async () => {
    await withRuntimeRest(
      async (cp, runtime) => {
        const books = await findDatabase(cp, "books");
        const book = await cp.createItem({ databaseId: books.id, properties: { name: "Book" } });
        await withTransaction(runtime, (client) => ensureItemAutomation(client, book.id));
        const view = await cp.createView({ databaseId: books.id, type: "table", name: "Books" });
        return { book, books, view };
      },
      async ({ runtime, cp, tenants, own, foreign, tokens, as }) => {
        const api = as(tokens[0]);
        const before = await runInTenant(tenants[1], () => cp.readAutomationForItems([foreign.book.id]));
        expect(await read(api(`/api/items/${own.book.id}?include=automation`))).toMatchObject({
          automation: { status: "pending" },
        });
        const randomItem = randomUUID();
        const itemStatus = await expectSameRefusal(
          await api(`/api/items/${foreign.book.id}?include=automation`),
          await api(`/api/items/${randomItem}?include=automation`),
          foreign.book.id,
          randomItem,
        );
        expect(itemStatus).toBe(404);
        for (const [kind, ownId, foreignId] of [
          ["databases", own.books.id, foreign.books.id],
          ["views", own.view.id, foreign.view.id],
        ] as const) {
          const query = (id: string) => api(`/api/${kind}/${id}/query`, "POST", { include: ["automation"] });
          expect(await read(query(ownId))).toMatchObject({
            items: expect.arrayContaining([
              expect.objectContaining({ id: own.book.id, automation: expect.objectContaining({ status: "pending" }) }),
            ]),
          });
          const randomId = randomUUID();
          expect(await expectSameRefusal(await query(foreignId), await query(randomId), foreignId, randomId)).toBe(404);
        }
        await runInTenant(tenants[0], () => enqueueLibraryMetadata(runtime, own.book.id, own.books.id));
        await runLibraryTask(
          runtime,
          async (url) =>
            new Response(
              JSON.stringify(url.includes("openlibrary.org") ? { docs: [] } : { kind: "books#volumes", totalItems: 0 }),
            ),
        );
        const nextFire = await runInTenant(tenants[0], () =>
          withTransaction(runtime, (client) =>
            client.query<{ next_fire_at: Date }>(
              "SELECT next_fire_at FROM project_heartbeats WHERE tenant_id = app_tenant_default() AND action_id = $1 AND action_config->>'databaseId' = $2",
              ["core.libraryMetadataRetrySweep", own.books.id],
            ),
          ),
        );
        expect(nextFire.rows).toHaveLength(1);
        expect(await read(api(`/api/items/${own.book.id}?include=automation`))).toMatchObject({
          automation: {
            status: "notFound",
            source: "googleBooks",
            nextAttemptAt: nextFire.rows[0]?.next_fire_at.toISOString(),
          },
        });
        expect(await runInTenant(tenants[1], () => cp.readAutomationForItems([foreign.book.id]))).toEqual(before);
      },
    );
  });

  it("enforces Threads.project cardinality through authenticated generic relation.put", async () => {
    await withRuntimeRest(
      async (cp, runtime, tenantId) => {
        const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
        const projects = await findDatabase(cp, "projects");
        await findDatabase(cp, "threads");
        const first = await cp.createItem({ databaseId: projects.id, properties: { name: "First" } });
        const second = await cp.createItem({ databaseId: projects.id, properties: { name: "Second" } });
        const emailProperty = async (key: string) => (await findProperty(cp, ids.emailsDatabaseId, key)).id;
        const folderRelationPropertyId = await emailProperty("folder");
        const attachmentsRelationPropertyId = await emailProperty("attachments");
        const mailboxFolderRelationPropertyId = (await findProperty(cp, ids.foldersDatabaseId, "mailbox")).id;
        const gmail: GmailMailClient = {
          getCurrentHistoryId: async () => "1",
          listHistorySince: async () => ({
            invalidated: false,
            newHistoryId: "2",
            changedMessageIds: [],
            removedMessageIds: [],
          }),
          listAllMessageIds: async () => ["message"],
          listLabels: async () => [{ id: "INBOX", name: "Inbox", type: "system" }],
          fetchMessage: async () => ({
            id: "message",
            threadId: "thread",
            labelIds: ["INBOX"],
            message: {
              messageId: `<${tenantId}@example.test>`,
              subject: "Thread",
              envelope: { from: { address: "sender@example.test" } },
              attachments: [],
            },
          }),
          modifyMessageLabels: async () => undefined,
        };
        const threadItemId = await withTransaction(runtime, async (client) => {
          const mailbox = await createItemWithClient(client, {
            databaseId: ids.mailboxesDatabaseId,
            properties: { name: "Mailbox", provider: "gmail" },
          });
          await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
          await reconcileGmailAccount(client, gmail, {
            mailboxItemId: mailbox.id,
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            foldersDatabaseId: ids.foldersDatabaseId,
            folderRelationPropertyId,
            attachmentsRelationPropertyId,
            mailboxFolderRelationPropertyId,
            storage: new LocalFsBlobStorageWriter(tmpBlobDir),
            storageKeyPrefix: "threads-contract",
          });
          const rows = await client.query<{ item_id: string }>(
            "SELECT item_id FROM mail_threads WHERE tenant_id = app_tenant_default() AND item_id IS NOT NULL",
          );
          if (rows.rows.length !== 1 || !rows.rows[0]) throw new Error("Expected canonical thread item");
          return rows.rows[0].item_id;
        });
        return { threadItemId, first: first.id, second: second.id };
      },
      async ({ runtime, tenants, own, foreign, tokens, as }) => {
        const put = (token: string | null, threadId: string, projectId: string) =>
          as(token)(`/api/items/${threadId}/relations/project/${projectId}`, "PUT", "{}");
        expect((await put(null, own.threadItemId, own.first)).status).toBe(401);
        expect(await read(put(tokens[0], own.threadItemId, own.first))).toMatchObject({
          itemA: own.threadItemId,
          itemB: own.first,
        });
        expect(await read(put(tokens[0], own.threadItemId, own.second), 400)).toMatchObject(
          validationFailed("project"),
        );
        const edges = async (tenantId: string, itemId: string) =>
          (
            await runInTenant(tenantId, () =>
              withTransaction(runtime, (client) =>
                client.query<{ item_a: string; item_b: string }>(
                  "SELECT item_a, item_b FROM item_relations WHERE tenant_id = app_tenant_default() AND (item_a = $1 OR item_b = $1) ORDER BY item_a, item_b",
                  [itemId],
                ),
              ),
            )
          ).rows;
        const ownBefore = await edges(tenants[0], own.threadItemId);
        const foreignBefore = await edges(tenants[1], foreign.threadItemId);
        expect(ownBefore).toEqual([{ item_a: own.threadItemId, item_b: own.first }]);
        expect(foreignBefore).toEqual([]);
        // A foreign session cannot see the thread; a foreign target is indistinguishable from an absent one.
        const missing = randomUUID();
        const denied = await put(tokens[1], own.threadItemId, foreign.first);
        const absent = await put(tokens[1], missing, foreign.first);
        expect(await expectSameRefusal(denied, absent, own.threadItemId, missing)).toBe(404);
        const missingTarget = randomUUID();
        await expectSameRefusal(
          await put(tokens[0], own.threadItemId, foreign.first),
          await put(tokens[0], own.threadItemId, missingTarget),
          foreign.first,
          missingTarget,
        );
        expect(await edges(tenants[0], own.threadItemId)).toEqual(ownBefore);
        expect(await edges(tenants[1], foreign.threadItemId)).toEqual(foreignBefore);
      },
    );
  });

  it("expands a tenant's real person, project and area through authenticated REST under RLS", async () => {
    await withRuntimeRest(
      async (cp, runtime) => {
        const [people, projects, areas, companies, files] = await Promise.all(
          ["people", "projects", "areas", "companies", "files"].map((moduleId) => findDatabase(cp, moduleId)),
        );
        if (!people || !projects || !areas || !companies || !files) throw new Error("Missing module database");
        const create = (databaseId: string, name: string) => cp.createItem({ databaseId, properties: { name } });
        const person = await create(people.id, "Person");
        const project = await create(projects.id, "Project");
        const secondProject = await create(projects.id, "Second project");
        const area = await create(areas.id, "Area");
        const otherArea = await create(areas.id, "Other area");
        const company = await create(companies.id, "Company");
        const file = await create(files.id, "File");
        for (const [databaseId, callerItemId, key, targetItemId] of [
          [people.id, person.id, "projects", project.id],
          [people.id, person.id, "companies", company.id],
          [projects.id, project.id, "area", area.id],
          [projects.id, secondProject.id, "area", area.id],
          [files.id, file.id, "projects", project.id],
          [files.id, file.id, "projects", secondProject.id],
        ] as const) {
          const property = await findProperty(cp, databaseId, key);
          await cp.createRelation({ relationPropertyId: property.id, callerItemId, targetItemId });
        }
        await withTransaction(runtime, (client) =>
          insertValueLink(client, {
            itemId: file.id,
            propertyKey: "area",
            ruleKey: "existingLink",
            sources: [{ kind: "item", sourceItemId: project.id, sourcePropertyKey: "area" }],
          }),
        );
        return { person, project, secondProject, area, otherArea, company, file, files, projects };
      },
      async ({ runtime, cp, tenants, own, foreign, tokens, as, defer }) => {
        const [ownTenant, foreignTenant] = tenants;
        const api = as(tokens[0]);
        const bothProjects = [own.project.id, own.secondProject.id].sort();
        const derivedLinks = {
          area: {
            valueKind: "derived",
            sources: expect.arrayContaining([
              expect.objectContaining({ itemId: own.project.id }),
              expect.objectContaining({ itemId: own.secondProject.id }),
            ]),
          },
        };
        for (const [query, hasLinks, hasDerived] of [
          ["", false, false],
          ["?include=links", true, false],
          ["?include=derived", false, true],
          ["?include=path,links,derived", true, true],
        ] as const) {
          const body = await read(api(`/api/items/${own.file.id}${query}`));
          if (hasDerived)
            expect(body).toMatchObject({
              derived: { area: { values: [{ id: own.area.id }], projectIds: bothProjects } },
            });
          else expect(body).not.toHaveProperty("derived");
          if (hasLinks && hasDerived) expect(body).toMatchObject({ links: derivedLinks });
          else if (hasLinks)
            expect(body).toMatchObject({
              links: {
                area: {
                  valueKind: "inherited",
                  sources: [expect.objectContaining({ itemId: own.project.id, propertyKey: "area" })],
                },
              },
            });
          else expect(body).not.toHaveProperty("links");
        }

        // The derived projection reads the file's projects once and serves it even when a project's area changes
        // right after that read committed.
        const { fileProjects, projectArea } = await runInTenant(ownTenant, async () => {
          const property = await findProperty(cp, own.files.id, "projects");
          const result = await withTransaction(runtime, (client) =>
            client.query<{ id: string }>(
              "SELECT id FROM relation_definitions WHERE tenant_id = app_tenant_default() AND $1 IN (property_id_a, property_id_b)",
              [property.id],
            ),
          );
          if (result.rows.length !== 1 || !result.rows[0]) throw new Error("Missing project definition");
          return { fileProjects: result.rows[0].id, projectArea: (await findProperty(cp, own.projects.id, "area")).id };
        });
        const writer = await createRuntimeRolePool(pool, "semprec_data");
        defer(() => writer.end());
        const writerCp = createChokePoint(writer);
        const setSecondProjectArea = (targetItemId: string | null) =>
          runInTenant(ownTenant, () =>
            writerCp.setRelation({ relationPropertyId: projectArea, callerItemId: own.secondProject.id, targetItemId }),
          );
        const originals = new Map<PoolClient, PoolClient["query"]>();
        const projectionClients = new Set<PoolClient>();
        let projectionReads = 0;
        let changedDuringRead = false;
        const observe = (client: PoolClient) => {
          if (originals.has(client)) return;
          // The original is invoked with its client as receiver via Reflect.apply below.
          // eslint-disable-next-line @typescript-eslint/unbound-method
          const original = client.query;
          originals.set(client, original);
          Object.defineProperty(client, "query", {
            configurable: true,
            writable: true,
            value: (...args: unknown[]) => {
              const [sql, params] = args;
              if (
                typeof sql === "string" &&
                sql.includes("FROM item_relations") &&
                sql.includes("relation_definition_id = $1") &&
                Array.isArray(params) &&
                params[0] === fileProjects
              ) {
                projectionReads++;
                projectionClients.add(client);
              }
              const result: unknown = Reflect.apply(original, client, args);
              if (sql === "COMMIT" && projectionClients.delete(client) && !changedDuringRead) {
                if (!(result instanceof Promise)) throw new Error("Expected asynchronous commit");
                changedDuringRead = true;
                return result.then(async (value: unknown) => {
                  await setSecondProjectArea(null);
                  return value;
                });
              }
              return result;
            },
          });
        };
        runtime.on("acquire", observe);
        let pathBody: unknown;
        try {
          pathBody = await read(api(`/api/items/${own.file.id}?include=path,links,derived`));
        } finally {
          runtime.off("acquire", observe);
          for (const [client, original] of originals)
            Object.defineProperty(client, "query", { configurable: true, writable: true, value: original });
        }
        expect(changedDuringRead).toBe(true);
        expect(projectionReads).toBe(1);
        expect(pathBody).toMatchObject({ derived: { area: { projectIds: bothProjects } }, links: derivedLinks });
        expect(await read(api(`/api/items/${own.file.id}?include=derived`))).toMatchObject({
          derived: { area: { projectIds: [own.project.id] } },
        });
        await setSecondProjectArea(own.area.id);
        await runInTenant(ownTenant, () =>
          cp.setRelation({
            relationPropertyId: projectArea,
            callerItemId: own.secondProject.id,
            targetItemId: own.otherArea.id,
          }),
        );
        expect(await read(api(`/api/items/${own.file.id}?include=derived`))).toMatchObject({
          derived: { area: { values: [{ id: own.area.id }, { id: own.otherArea.id }], projectIds: bothProjects } },
        });
        expect((await api(`/api/items/${foreign.file.id}?include=derived`)).status).toBe(404);
        expect((await api(`/api/items/${randomUUID()}?include=derived`)).status).toBe(404);

        // Each tenant expands its own person's relations, nested area included.
        const fetchPerson = (token: string, id: string) =>
          as(token)(`/api/items/${id}?include=relations&relations.projects=area&relations.companies=`);
        const decorated = (id: string, title: string) => ({
          id,
          title,
          color: expect.stringMatching(/\S/),
          icon: expect.stringMatching(/\S/),
        });
        for (const [token, expected] of [
          [tokens[0], own],
          [tokens[1], foreign],
        ] as const) {
          expect(await read(fetchPerson(token, expected.person.id))).toMatchObject({
            id: expected.person.id,
            relations: {
              companies: [expect.objectContaining(decorated(expected.company.id, "Company"))],
              projects: [
                expect.objectContaining({
                  ...decorated(expected.project.id, "Project"),
                  properties: { area: [expect.objectContaining(decorated(expected.area.id, "Area"))] },
                }),
              ],
            },
            relationsTruncated: [],
          });
        }

        // A bare `include=relations` expands up to five relation properties and refuses a sixth.
        const bare = await runInTenant(ownTenant, async () => {
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
        const bareUrl = `/api/items/${bare.caller.id}?include=relations`;
        expect(await read(api(bareUrl))).toMatchObject({
          relations: Object.fromEntries(
            Array.from({ length: 5 }, (_, i) => [`link${i}`, [expect.objectContaining({ id: bare.destination.id })]]),
          ),
        });
        await runInTenant(ownTenant, () =>
          cp.createRelationProperty({
            sourceDatabaseId: bare.source.id,
            targetDatabaseId: bare.target.id,
            key: "link5",
            name: "Link 5",
          }),
        );
        expect(await read(api(bareUrl), 400)).toMatchObject(validationFailed("include.relations"));

        // A foreign person reads exactly like an absent one and changes nothing in either tenant.
        const snapshot = (tenantId: string) =>
          runInTenant(tenantId, async () => ({
            items: (
              await runtime.query<{ id: string; properties: unknown; computed: unknown }>(
                "SELECT id, properties, computed FROM items ORDER BY id",
              )
            ).rows,
            edges: (
              await runtime.query<{ id: string; item_a: string; item_b: string }>(
                "SELECT id, item_a, item_b FROM item_relations ORDER BY id",
              )
            ).rows,
          }));
        const ownBefore = await snapshot(ownTenant);
        const foreignBefore = await snapshot(foreignTenant);
        const missing = randomUUID();
        const denied = await fetchPerson(tokens[1], own.person.id);
        const absent = await fetchPerson(tokens[1], missing);
        expect(await expectSameRefusal(denied, absent, own.person.id, missing)).toBe(404);
        expect(await snapshot(ownTenant)).toEqual(ownBefore);
        expect(await snapshot(foreignTenant)).toEqual(foreignBefore);
      },
    );
  });
});
