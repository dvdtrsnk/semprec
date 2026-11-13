import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
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
 * One REST exercise per operation in the closed 47-operation catalog (issue #219's acceptance
 * criterion: "a parameterized contract test covers all 28 operations over REST", extended to
 * `property.getByKey` by issue #432). Each case
 * issues the real HTTP request a REST caller would send and asserts only that it reaches
 * `genericApplicationService` through `GENERIC_OPERATION_BINDINGS` and succeeds — the exhaustive
 * per-field/per-error-branch behavior for each route already lives in its own handler test file
 * (`itemsHandler.test.ts`, `databasesHandler.test.ts`, `propertiesHandler.test.ts`,
 * `viewsHandler.test.ts`). The `Object.keys(CASES)` assertion below is what keeps this list
 * honest as the catalog evolves: an operation with no case here fails that assertion.
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
    const color = await fetch(`${baseUrl}/api/databases/${fx.database.id}/properties`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        key: "colorChoice",
        name: "Color choice",
        type: "select",
        config: { options: [{ key: "one", color: "#ff3b30" }] },
      }),
    });
    expect(color.status).toBe(201);
    expect(await color.json()).toMatchObject({ config: { options: [{ key: "one", color: "#FF3B30" }] } });
    for (const invalid of ["red", "#FFF", "#GGGGGG", 1]) {
      const rejected = await fetch(`${baseUrl}/api/databases/${fx.database.id}/properties`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          key: "badColor",
          name: "Bad",
          type: "select",
          config: { options: [{ key: "one", color: invalid }] },
        }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        error: { code: "validation_failed", details: { field: "config" } },
      });
    }
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
    const created = await fetch(`${baseUrl}/api/databases/${fx.database.id}/properties`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        key: "patchColor",
        name: "Patch color",
        type: "select",
        config: { options: [{ key: "one" }] },
      }),
    });
    expect(created.status).toBe(201);
    const createdBody: unknown = await created.json();
    if (
      typeof createdBody !== "object" ||
      createdBody === null ||
      !("id" in createdBody) ||
      typeof createdBody.id !== "string"
    )
      throw new Error("Missing property id");
    const propertyId = createdBody.id;
    const patch = (color: unknown) =>
      fetch(`${baseUrl}/api/properties/${propertyId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ config: { options: [{ key: "one", color }] } }),
      });
    const valid = await patch("#ff3b30");
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ config: { options: [{ key: "one", color: "#FF3B30" }] } });
    const invalid = await patch("red");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed", details: { field: "config" } } });
  },
  "property.option.add": async (fx, headers, baseUrl) => {
    const tags = await chokePoint.createProperty({
      databaseId: fx.database.id,
      key: "tags",
      name: "Tags",
      type: "multi_select",
      config: { options: [{ key: "herbs", label: "Herbs" }] },
    });
    const res = await fetch(`${baseUrl}/api/properties/${tags.id}/options`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Spices", color: "#34c759" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ key: "spices", label: "Spices", color: "#34C759" });
    expect((await chokePoint.getProperty(tags.id))?.config.options).toEqual([
      { key: "herbs", label: "Herbs" },
      { key: "spices", label: "Spices", color: "#34C759" },
    ]);
  },
  "property.option.update": async (fx, headers, baseUrl) => {
    const tags = await chokePoint.createProperty({
      databaseId: fx.database.id,
      key: "tags",
      name: "Tags",
      type: "multi_select",
      config: { options: [{ key: "herbs", label: "Herbs" }] },
    });
    const res = await fetch(`${baseUrl}/api/properties/${tags.id}/options/herbs`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "Fresh herbs" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "herbs", label: "Fresh herbs" });
    expect((await chokePoint.getProperty(tags.id))?.config.options).toEqual([{ key: "herbs", label: "Fresh herbs" }]);
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
  "relation.related": async (fx, headers, baseUrl) => {
    // `itemA` is linked to the target item, and the target database holds the inverse property of that relation.
    const res = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/related`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        databaseKey: null,
        databaseId: fx.targetDatabase.id,
        count: 1,
        via: "direct",
        filter: { type: "relation_contains", property: "assignedFrom", value: fx.itemA.id },
      },
    ]);
  },
  "link.unlink": async (fx, headers, baseUrl) => {
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: fx.itemA.id,
        propertyKey: "title",
        ruleKey: "test",
        sources: [{ kind: "item", sourceItemId: fx.itemB.id, sourcePropertyKey: "title" }],
      }),
    );
    const res = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/links/title/unlink`, { method: "POST", headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
  },
  "link.relink": async (fx, headers, baseUrl) => {
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: fx.itemA.id,
        propertyKey: "title",
        ruleKey: "test",
        state: "broken",
        brokenBy: "user",
        brokenAt: new Date(),
        sources: [{ kind: "item", sourceItemId: fx.itemB.id, sourcePropertyKey: "title" }],
      }),
    );
    const res = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/links/title/relink`, { method: "POST", headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valueKind: "inherited" });
    expect((await chokePoint.getItem(fx.database.id, fx.itemA.id))?.properties.title).toBe(fx.itemB.properties.title);
  },
  "page.ensure": async (fx, headers, baseUrl) => {
    const response = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page`, { method: "PUT", headers });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ docId: expect.any(String) });
    const read = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page`, { headers });
    if (typeof body !== "object" || body === null || !("docId" in body) || typeof body.docId !== "string")
      throw new Error("Missing docId");
    const summary: unknown = await read.json();
    expect(summary).toMatchObject({ docId: body.docId });
  },
  // The REST equivalent of this operation is the lazy-creating route of issue #1541, not a new route.
  "page.ensureJournalPeriod": async (_fx, headers, baseUrl) => {
    const response = await fetch(`${baseUrl}/api/journal/periods/week/2026-W42/doc`, { method: "PUT", headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      itemId: expect.any(String),
      docId: expect.any(String),
      period: "2026-W42",
      range: { from: "2026-10-12", to: "2026-10-18" },
    });
  },
  // The operation has no REST route: a merge action in the app is out of scope of issue #2017. The case dispatches the
  // binding as a person's REST session, the way a route would, over a period with two live entries.
  "page.mergeJournalDuplicates": async () => {
    const journal = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "journal"));
    if (!journal) throw new Error("Journal database is not seeded");
    // A state the lazy creation never produces (it reuses the live entry of a period), so the fixture creates both entries directly.
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
  "page.createSubpage": async (fx, headers, baseUrl) => {
    const response = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page/subpages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Release checklist" }),
    });
    expect(response.status).toBe(201);
    const created = z
      .object({
        pages: z.array(z.object({ pageItemId: z.string(), docId: z.string(), blockId: z.string() }).strict()).length(1),
      })
      .strict()
      .parse(await response.json());
    const [page] = created.pages;
    const read = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page`, { headers });
    expect(await read.json()).toMatchObject({
      subpageCount: 1,
      blocks: [{ id: page?.blockId, type: "page", pageId: page?.pageItemId, text: "Release checklist" }],
    });
  },
  "page.duplicate": async (fx, headers, baseUrl) => {
    const original = (await createDocStore(pool).createSubpage({ parent: { itemId: fx.itemA.id } }, "user")).pages[0];
    if (!original) throw new Error("Missing page");
    const response = await fetch(`${baseUrl}/api/items/${original.pageItemId}/page/duplicate`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(201);
    const copy = z
      .object({ pageItemId: z.string(), docId: z.string(), blockId: z.string() })
      .strict()
      .parse(await response.json());
    const read = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page`, { headers });
    expect(await read.json()).toMatchObject({
      subpageCount: 2,
      blocks: [
        { id: original.blockId, type: "page", pageId: original.pageItemId },
        { id: copy.blockId, type: "page", pageId: copy.pageItemId },
      ],
    });
  },
  "page.rename": async (fx, headers, baseUrl) => {
    const page = (
      await createDocStore(pool).createSubpage({ parent: { itemId: fx.itemA.id }, title: "Before" }, "user")
    ).pages[0];
    if (!page) throw new Error("Missing page");
    const response = await fetch(`${baseUrl}/api/items/${page.pageItemId}/page/title`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "After" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pageItemId: page.pageItemId, title: "After" });
    const read = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page`, { headers });
    expect(await read.json()).toMatchObject({
      blocks: [{ id: page.blockId, type: "page", pageId: page.pageItemId, text: "After" }],
    });
  },
  "page.insert": async (fx, headers, baseUrl) => {
    const response = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page/insert`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ placement: "end", markdown: "First line\n\nSecond line" }),
    });
    expect(response.status).toBe(200);
    const inserted = z
      .object({ blockIds: z.array(z.string()).length(2) })
      .strict()
      .parse(await response.json());
    const read = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page`, { headers });
    expect(await read.json()).toMatchObject({
      blockCount: 2,
      blocks: [
        { id: inserted.blockIds[0], text: "First line" },
        { id: inserted.blockIds[1], text: "Second line" },
      ],
    });
  },
  "page.replace": async (fx, headers, baseUrl) => {
    // The page of an item without a document has the version token of an empty document; replacing it creates the page.
    const read = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page.md`, { headers });
    const etag = read.headers.get("etag");
    expect(etag).not.toBeNull();
    const response = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page.md`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "text/markdown", "If-Match": etag ?? "" },
      body: "Replaced line",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ trashedPages: [] });
    const page = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page`, { headers });
    expect(await page.json()).toMatchObject({ blockCount: 1, blocks: [{ text: "Replaced line" }] });
  },
  "page.changes": async (fx, headers, baseUrl) => {
    const since = encodeURIComponent(new Date(Date.now() - 60 * 1000).toISOString());
    const response = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page/changes?since=${since}`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  },
  "page.get": async (fx, headers, baseUrl) => {
    const response = await fetch(`${baseUrl}/api/items/${fx.itemA.id}/page`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ docId: null, blocks: [], blockCount: 0, subpageCount: 0 });
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
  "item.count": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/items/count`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        items: [{ databaseId: fx.database.id, groupBy: fx.relationProperty.key }, { databaseId: fx.targetDatabase.id }],
      }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    // `itemA` is linked to the target item and `itemB` to none.
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
  "database.facets": async (fx, headers, baseUrl) => {
    const res = await fetch(`${baseUrl}/api/databases/${fx.database.id}/facets`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        facets: [fx.relationProperty.key, fx.property.key],
        extra: { open: { type: "equals", property: fx.property.key, value: "Dune" } },
      }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    // `itemA` is linked to the target item and `itemB` to none; `itemB` alone is titled "Dune".
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
  search: async (_fx, headers, baseUrl) => {
    const tasks = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "tasks"));
    if (!tasks) throw new Error("Tasks not seeded");
    const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { name: "Contract search task" } });
    const res = await fetch(`${baseUrl}/api/search?q=contract%20search&scope=task,event&perGroupLimit=2`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
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
    const headers = await authHeader();
    const unlink = () => fetch(`${baseUrl}/api/items/${file.id}/links/projects/unlink`, { method: "POST", headers });
    const first = await unlink();
    expect(first.status).toBe(200);
    const body: unknown = await first.json();
    expect(body).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user", brokenAt: expect.any(String) });
    expect((await chokePoint.listItemRelations(file.id, property.id))?.map((edge) => edge.targetItemId)).toEqual([
      project.id,
    ]);
    const again = await unlink();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(body);
  });

  it("returns link conflicts over REST without changing the target or link", async () => {
    const fx = await buildFixtures();
    const headers = await authHeader();
    const relink = () => fetch(`${baseUrl}/api/items/${fx.itemA.id}/links/title/relink`, { method: "POST", headers });
    const beforeItem = await chokePoint.getItem(fx.database.id, fx.itemA.id);
    const missing = await relink();
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: { code: "value_link_conflict" } });
    expect(await chokePoint.getItem(fx.database.id, fx.itemA.id)).toEqual(beforeItem);

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
    const beforeLinks = await chokePoint.getValueLinksForItems([fx.itemA.id]);
    const overCardinality = await relink();
    expect(overCardinality.status).toBe(409);
    expect(await overCardinality.json()).toMatchObject({ error: { code: "value_link_conflict" } });
    expect(await chokePoint.getItem(fx.database.id, fx.itemA.id)).toEqual(beforeItem);
    expect(await chokePoint.getValueLinksForItems([fx.itemA.id])).toEqual(beforeLinks);

    await chokePoint.softDeleteItem(fx.database.id, fx.itemB.id);
    await chokePoint.softDeleteItem(fx.database.id, other.id);
    const linksWithoutSources = await chokePoint.getValueLinksForItems([fx.itemA.id]);
    const noLiveSource = await relink();
    expect(noLiveSource.status).toBe(409);
    expect(await noLiveSource.json()).toMatchObject({ error: { code: "value_link_conflict" } });
    expect(await chokePoint.getItem(fx.database.id, fx.itemA.id)).toEqual(beforeItem);
    expect(await chokePoint.getValueLinksForItems([fx.itemA.id])).toEqual(linksWithoutSources);
  });

  it("filters the system area from database.query and refuses its deletion", async () => {
    const areas = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
    if (!areas) throw new Error("Areas missing");
    const list = await chokePoint.listItems(areas.id);
    const system = list.items.find((item) => item.properties.systemActive === true);
    if (!system) throw new Error("System area missing");
    const user = await chokePoint.createItem({ databaseId: areas.id, properties: { name: "User area" } });
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const deletion = await fetch(`${baseUrl}/api/items/${system.id}`, { method: "DELETE", headers });
    expect(deletion.status).toBe(403);
    expect(await deletion.json()).toMatchObject({ error: { details: { field: "systemActive" } } });
    const query = await fetch(`${baseUrl}/api/databases/${areas.id}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filter: { type: "is_empty", property: "systemActive" } }),
    });
    expect(query.status).toBe(200);
    const result: unknown = await query.json();
    expect(result).toMatchObject({ items: [expect.objectContaining({ id: user.id })] });
    expect(JSON.stringify(result)).not.toContain(system.id);
    expect(await chokePoint.getItem(areas.id, system.id)).toEqual(system);
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

  it("exposes automation only when requested on the three generic reads", async () => {
    const fx = await buildFixtures();
    await withTransaction(pool, (client) => ensureItemAutomation(client, fx.itemA.id));
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const bare = await fetch(`${baseUrl}/api/items/${fx.itemA.id}`, { headers });
    const explicitOff = await fetch(`${baseUrl}/api/items/${fx.itemA.id}?include=`, { headers });
    expect(bare.status).toBe(200);
    expect(await bare.text()).toBe(await explicitOff.text());
    const item = await fetch(`${baseUrl}/api/items/${fx.itemA.id}?include=automation`, { headers });
    expect(item.status).toBe(200);
    expect(await item.json()).toMatchObject({
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
    const missing = await fetch(`${baseUrl}/api/items/${fx.itemB.id}?include=automation`, { headers });
    expect(missing.status).toBe(200);
    expect(await missing.json()).not.toHaveProperty("automation");
    for (const path of [`/api/databases/${fx.database.id}/query`, `/api/views/${fx.curatedView.id}/query`]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ include: ["automation"] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ id: fx.itemA.id, automation: expect.objectContaining({ status: "pending" }) }),
        ]),
      });
    }
    const taskName = CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS;
    await runInTenant(getTenantZeroId(), async () => {
      await chokePoint.createProperty({ databaseId: fx.database.id, key: "name", name: "Name", type: "text" });
      await chokePoint.updateItem({
        databaseId: fx.database.id,
        itemId: fx.itemA.id,
        propertiesPatch: { name: "Arrival" },
      });
    });
    await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) =>
        enqueueJob(
          client,
          taskName,
          { itemId: fx.itemA.id, databaseId: fx.database.id, config: { source: "openLibrary", coverKey: "cover" } },
          { jobKey: `library-metadata:${fx.itemA.id}`, maxAttempts: 3 },
        ),
      ),
    );
    let providerCalls = 0;
    const task = createCoreTaskList(
      pool,
      new Map(),
      createLibraryMetadataFetcher({
        fetch: async () => {
          providerCalls++;
          return new Response("secret-provider-response", { status: 503 });
        },
      }),
    )[taskName];
    if (!task) throw new Error("Library task missing");
    await runOnce({ pgPool: pool, taskList: { [taskName]: task } });
    expect(providerCalls).toBe(2);
    const failed = await fetch(`${baseUrl}/api/items/${fx.itemA.id}?include=automation`, { headers });
    expect(failed.status).toBe(200);
    const failedText = await failed.text();
    expect(failedText).not.toContain("secret-provider-response");
    const failedBody: unknown = JSON.parse(failedText);
    expect(failedBody).toMatchObject({
      automation: {
        status: "error",
        errorCode: "sourceUnavailable",
        attempts: 1,
        source: "googleBooks",
      },
    });
  });

  it("keeps automation includes tenant-scoped on the real REST runtime pool", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let ownedServer: Server | undefined;
    const failures: unknown[] = [];
    try {
      const role = await runAsSystem("test:automation-runtime-role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenants = [await createTestTenant(pool), await createTestTenant(pool)];
      const passwordHash = await hashPassword(PASSWORD);
      const users = await runAsSystem("test:automation-users", () =>
        Promise.all(
          tenants.map((tenantId) =>
            createUser(pool, { tenantId, email: `${randomUUID()}@example.test`, passwordHash }),
          ),
        ),
      );
      const cp = createChokePoint(runtime);
      const fixture = (tenantId: string) =>
        runInTenant(tenantId, async () => {
          await seedSystem(runtime, createViewTypeRegistry());
          const books = (await cp.listDatabases()).find((db) => db.ownerModuleId === "books");
          if (!books) throw new Error("Books missing");
          const book = await cp.createItem({ databaseId: books.id, properties: { name: "Book" } });
          await withTransaction(runtime, (client) => ensureItemAutomation(client, book.id));
          const view = await cp.createView({ databaseId: books.id, type: "table", name: "Books" });
          return { book, books, view };
        });
      const own = await fixture(tenants[0]!);
      const foreign = await fixture(tenants[1]!);
      const session = await login(pool, {
        email: users[0]!.email,
        password: PASSWORD,
        platform: "ios",
        ip: "127.0.0.1",
      });
      const dispatch = await createDispatcher(runtime, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      });
      ownedServer = createServer(dispatch);
      const server = ownedServer;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing REST address");
      const headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
      const base = `http://127.0.0.1:${address.port}`;
      const before = await runInTenant(tenants[1]!, () => cp.readAutomationForItems([foreign.book.id]));
      const ownItem = await fetch(`${base}/api/items/${own.book.id}?include=automation`, { headers });
      expect(ownItem.status).toBe(200);
      expect(await ownItem.json()).toMatchObject({ automation: { status: "pending" } });
      const compareRefusals = async (
        foreignResponse: Response,
        randomResponse: Response,
        foreignId: string,
        randomId: string,
      ) => {
        expect(foreignResponse.status).toBe(404);
        expect(randomResponse.status).toBe(foreignResponse.status);
        for (const header of ["content-type", "cache-control", "vary"]) {
          expect(foreignResponse.headers.get(header)).toBe(randomResponse.headers.get(header));
        }
        const foreignBody = (await foreignResponse.text()).replaceAll(foreignId, "<id>");
        const randomBody = (await randomResponse.text()).replaceAll(randomId, "<id>");
        expect(foreignBody).toBe(randomBody);
      };
      const randomItem = randomUUID();
      await compareRefusals(
        await fetch(`${base}/api/items/${foreign.book.id}?include=automation`, { headers }),
        await fetch(`${base}/api/items/${randomItem}?include=automation`, { headers }),
        foreign.book.id,
        randomItem,
      );
      for (const [kind, ownId, foreignId] of [
        ["databases", own.books.id, foreign.books.id],
        ["views", own.view.id, foreign.view.id],
      ] as const) {
        const query = (id: string) =>
          fetch(`${base}/api/${kind}/${id}/query`, {
            method: "POST",
            headers,
            body: JSON.stringify({ include: ["automation"] }),
          });
        const positive = await query(ownId);
        expect(positive.status).toBe(200);
        expect(await positive.json()).toMatchObject({
          items: expect.arrayContaining([
            expect.objectContaining({ id: own.book.id, automation: expect.objectContaining({ status: "pending" }) }),
          ]),
        });
        const randomId = randomUUID();
        await compareRefusals(await query(foreignId), await query(randomId), foreignId, randomId);
      }
      const taskName = CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS;
      await runInTenant(tenants[0]!, () =>
        withTransaction(runtime, (client) =>
          enqueueJob(
            client,
            taskName,
            { itemId: own.book.id, databaseId: own.books.id, config: { source: "openLibrary", coverKey: "cover" } },
            { jobKey: `library-metadata:${own.book.id}`, maxAttempts: 3 },
          ),
        ),
      );
      const task = createCoreTaskList(
        runtime,
        new Map(),
        createLibraryMetadataFetcher({
          fetch: async (url) =>
            new Response(
              JSON.stringify(url.includes("openlibrary.org") ? { docs: [] } : { kind: "books#volumes", totalItems: 0 }),
            ),
        }),
      )[taskName];
      if (!task) throw new Error("Library task missing");
      await runOnce({ pgPool: runtime, taskList: { [taskName]: task } });
      const nextFire = await runInTenant(tenants[0]!, () =>
        withTransaction(runtime, (client) =>
          client.query<{ next_fire_at: Date }>(
            "SELECT next_fire_at FROM project_heartbeats WHERE tenant_id = app_tenant_default() AND action_id = $1 AND action_config->>'databaseId' = $2",
            ["core.libraryMetadataRetrySweep", own.books.id],
          ),
        ),
      );
      expect(nextFire.rows).toHaveLength(1);
      const notFound = await fetch(`${base}/api/items/${own.book.id}?include=automation`, { headers });
      expect(notFound.status).toBe(200);
      expect(await notFound.json()).toMatchObject({
        automation: {
          status: "notFound",
          source: "googleBooks",
          nextAttemptAt: nextFire.rows[0]!.next_fire_at.toISOString(),
        },
      });
      expect(await runInTenant(tenants[1]!, () => cp.readAutomationForItems([foreign.book.id]))).toEqual(before);
    } catch (error) {
      failures.push(error);
    }
    if (ownedServer) {
      const server = ownedServer;
      try {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await runtime.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Automation REST test and cleanup failed");
  });

  it("enforces Threads.project cardinality through authenticated generic relation.put", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let runtimeServer: Server | undefined;
    const failures: unknown[] = [];
    try {
      const role = await runAsSystem("test:verify-threads-runtime-role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const ownTenant = await createTestTenant(pool);
      const foreignTenant = await createTestTenant(pool);
      const passwordHash = await hashPassword(PASSWORD);
      const users = await runAsSystem("test:create-threads-users", () =>
        Promise.all(
          [ownTenant, foreignTenant].map((tenantId) =>
            createUser(pool, { tenantId, email: `${randomUUID()}@example.test`, passwordHash }),
          ),
        ),
      );
      const cp = createChokePoint(runtime);
      const fixture = (tenantId: string) =>
        runInTenant(tenantId, async () => {
          await seedSystem(runtime, createViewTypeRegistry());
          const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
          const databases = await cp.listDatabases();
          const threads = databases.find((database) => database.ownerModuleId === "threads");
          const projects = databases.find((database) => database.ownerModuleId === "projects");
          if (!threads || !projects) throw new Error("Missing Threads or Projects database");
          const first = await cp.createItem({ databaseId: projects.id, properties: { name: "First" } });
          const second = await cp.createItem({ databaseId: projects.id, properties: { name: "Second" } });
          const emailProperties = await cp.listProperties(ids.emailsDatabaseId);
          const folderProperties = await cp.listProperties(ids.foldersDatabaseId);
          const propertyId = (properties: PropertyRow[], key: string) => {
            const property = properties.find((entry) => entry.key === key);
            if (!property) throw new Error(`Missing ${key} property`);
            return property.id;
          };
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
              folderRelationPropertyId: propertyId(emailProperties, "folder"),
              attachmentsRelationPropertyId: propertyId(emailProperties, "attachments"),
              mailboxFolderRelationPropertyId: propertyId(folderProperties, "mailbox"),
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
        });
      const own = await fixture(ownTenant);
      const foreign = await fixture(foreignTenant);
      const tokens = await Promise.all(
        users.map((user) => login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" })),
      );
      const ownToken = tokens[0]?.token;
      const foreignToken = tokens[1]?.token;
      if (!ownToken || !foreignToken) throw new Error("Missing test sessions");
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
      const put = (token: string | null, threadId: string, projectId: string) =>
        fetch(`http://127.0.0.1:${address.port}/api/items/${threadId}/relations/project/${projectId}`, {
          method: "PUT",
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
          body: "{}",
        });
      expect((await put(null, own.threadItemId, own.first)).status).toBe(401);
      const first = await put(ownToken, own.threadItemId, own.first);
      expect(first.status).toBe(200);
      const firstBody: unknown = await first.json();
      expect(firstBody).toMatchObject({ itemA: own.threadItemId, itemB: own.first });
      const second = await put(ownToken, own.threadItemId, own.second);
      expect(second.status).toBe(400);
      expect(await second.json()).toMatchObject({
        error: { code: "validation_failed", details: { field: "project" } },
      });
      const edges = (tenantId: string, itemId: string) =>
        runInTenant(tenantId, () =>
          withTransaction(runtime, (client) =>
            client.query<{ item_a: string; item_b: string }>(
              "SELECT item_a, item_b FROM item_relations WHERE tenant_id = app_tenant_default() AND (item_a = $1 OR item_b = $1) ORDER BY item_a, item_b",
              [itemId],
            ),
          ),
        );
      const ownBefore = (await edges(ownTenant, own.threadItemId)).rows;
      const foreignBefore = (await edges(foreignTenant, foreign.threadItemId)).rows;
      expect(ownBefore).toEqual([{ item_a: own.threadItemId, item_b: own.first }]);
      expect(foreignBefore).toEqual([]);
      const missing = randomUUID();
      const denied = await put(foreignToken, own.threadItemId, foreign.first);
      const absent = await put(foreignToken, missing, foreign.first);
      expect(denied.status).toBe(404);
      expect(absent.status).toBe(404);
      const deniedBody = await denied.text();
      const absentBody = await absent.text();
      expect(deniedBody.replaceAll(own.threadItemId, "<item>")).toBe(absentBody.replaceAll(missing, "<item>"));
      const foreignTarget = await put(ownToken, own.threadItemId, foreign.first);
      const missingTarget = randomUUID();
      const randomTarget = await put(ownToken, own.threadItemId, missingTarget);
      expect(foreignTarget.status).toBe(randomTarget.status);
      expect(foreignTarget.status).toBeGreaterThanOrEqual(400);
      expect((await foreignTarget.text()).replaceAll(foreign.first, "<target>")).toBe(
        (await randomTarget.text()).replaceAll(missingTarget, "<target>"),
      );
      expect((await edges(ownTenant, own.threadItemId)).rows).toEqual(ownBefore);
      expect((await edges(foreignTenant, foreign.threadItemId)).rows).toEqual(foreignBefore);
    } catch (error) {
      failures.push(error);
    }
    if (runtimeServer?.listening) {
      try {
        const ownedServer = runtimeServer;
        await new Promise<void>((resolve, reject) => ownedServer.close((error) => (error ? reject(error) : resolve())));
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await runtime.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Threads generic relation fixture failed");
  });

  it("expands a tenant's real person, project and area through authenticated REST under RLS", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let runtimeWriter: Pool | undefined;
    let runtimeServer: Server | undefined;
    let failure: { error: unknown } | undefined;
    const cleanupErrors: unknown[] = [];
    try {
      runtimeWriter = await createRuntimeRolePool(pool, "semprec_data");
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
          const files = find("files");
          const person = await cp.createItem({ databaseId: people.id, properties: { name: "Person" } });
          const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Project" } });
          const secondProject = await cp.createItem({
            databaseId: projects.id,
            properties: { name: "Second project" },
          });
          const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Area" } });
          const otherArea = await cp.createItem({ databaseId: areas.id, properties: { name: "Other area" } });
          const company = await cp.createItem({ databaseId: companies.id, properties: { name: "Company" } });
          const file = await cp.createItem({ databaseId: files.id, properties: { name: "File" } });
          async function link(databaseId: string, callerItemId: string, key: string, targetItemId: string) {
            const property = (await cp.listProperties(databaseId)).find((entry) => entry.key === key);
            if (!property) throw new Error("Missing fixture relation");
            await cp.createRelation({ relationPropertyId: property.id, callerItemId, targetItemId });
          }
          await link(people.id, person.id, "projects", project.id);
          await link(people.id, person.id, "companies", company.id);
          await link(projects.id, project.id, "area", area.id);
          await link(projects.id, secondProject.id, "area", area.id);
          await link(files.id, file.id, "projects", project.id);
          await link(files.id, file.id, "projects", secondProject.id);
          // Existing value links are created by their production store before propagation is delivered.
          await withTransaction(runtime, (client) =>
            insertValueLink(client, {
              itemId: file.id,
              propertyKey: "area",
              ruleKey: "existingLink",
              sources: [{ kind: "item", sourceItemId: project.id, sourcePropertyKey: "area" }],
            }),
          );
          return {
            person,
            project,
            secondProject,
            area,
            otherArea,
            company,
            file,
            filesDatabaseId: files.id,
            projectsDatabaseId: projects.id,
          };
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
      for (const [query, hasLinks, hasDerived] of [
        ["", false, false],
        ["?include=links", true, false],
        ["?include=derived", false, true],
        ["?include=path,links,derived", true, true],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${port}/api/items/${own.file.id}${query}`, {
          headers: { Authorization: `Bearer ${firstToken}` },
        });
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        if (hasDerived)
          expect(body).toMatchObject({
            derived: {
              area: {
                values: [{ id: own.area.id }],
                projectIds: [own.project.id, own.secondProject.id].sort(),
              },
            },
          });
        else expect(body).not.toHaveProperty("derived");
        if (hasLinks && hasDerived)
          expect(body).toMatchObject({
            links: {
              area: {
                valueKind: "derived",
                sources: expect.arrayContaining([
                  expect.objectContaining({ itemId: own.project.id }),
                  expect.objectContaining({ itemId: own.secondProject.id }),
                ]),
              },
            },
          });
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
      const fileProjects = await runInTenant(ownTenant, async () => {
        const property = (await cp.listProperties(own.filesDatabaseId)).find((entry) => entry.key === "projects");
        if (!property) throw new Error("Missing file project property");
        const result = await withTransaction(runtime, (client) =>
          client.query<{ id: string }>(
            "SELECT id FROM relation_definitions WHERE tenant_id = app_tenant_default() AND $1 IN (property_id_a, property_id_b)",
            [property.id],
          ),
        );
        if (result.rows.length !== 1 || !result.rows[0]) throw new Error("Missing project definition");
        return result.rows[0].id;
      });
      const projectArea = await runInTenant(ownTenant, async () => {
        const property = (await cp.listProperties(own.projectsDatabaseId)).find((entry) => entry.key === "area");
        if (!property) throw new Error("Missing project area property");
        return property.id;
      });
      const writer = runtimeWriter;
      if (!writer) throw new Error("Missing runtime writer");
      const writerCp = createChokePoint(writer);
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
            const sql = args[0];
            const params = args[1];
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
                await runInTenant(ownTenant, () =>
                  writerCp.setRelation({
                    relationPropertyId: projectArea,
                    callerItemId: own.secondProject.id,
                    targetItemId: null,
                  }),
                );
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
        const response = await fetch(`http://127.0.0.1:${port}/api/items/${own.file.id}?include=path,links,derived`, {
          headers: { Authorization: `Bearer ${firstToken}` },
        });
        expect(response.status).toBe(200);
        pathBody = await response.json();
      } finally {
        runtime.off("acquire", observe);
        for (const [client, original] of originals)
          Object.defineProperty(client, "query", { configurable: true, writable: true, value: original });
      }
      expect(changedDuringRead).toBe(true);
      expect(projectionReads).toBe(1);
      expect(pathBody).toMatchObject({
        derived: { area: { projectIds: [own.project.id, own.secondProject.id].sort() } },
        links: {
          area: {
            valueKind: "derived",
            sources: expect.arrayContaining([
              expect.objectContaining({ itemId: own.project.id }),
              expect.objectContaining({ itemId: own.secondProject.id }),
            ]),
          },
        },
      });
      const afterDrift = await fetch(`http://127.0.0.1:${port}/api/items/${own.file.id}?include=derived`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      });
      expect(afterDrift.status).toBe(200);
      expect(await afterDrift.json()).toMatchObject({ derived: { area: { projectIds: [own.project.id] } } });
      await runInTenant(ownTenant, () =>
        writerCp.setRelation({
          relationPropertyId: projectArea,
          callerItemId: own.secondProject.id,
          targetItemId: own.area.id,
        }),
      );
      await runInTenant(ownTenant, async () => {
        const property = (await cp.listProperties(own.projectsDatabaseId)).find((entry) => entry.key === "area");
        if (!property) throw new Error("Missing project area relation");
        await cp.setRelation({
          relationPropertyId: property.id,
          callerItemId: own.secondProject.id,
          targetItemId: own.otherArea.id,
        });
      });
      const changed = await fetch(`http://127.0.0.1:${port}/api/items/${own.file.id}?include=derived`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toMatchObject({
        derived: {
          area: {
            values: [{ id: own.area.id }, { id: own.otherArea.id }],
            projectIds: [own.project.id, own.secondProject.id].sort(),
          },
        },
      });
      const foreignFile = await fetch(`http://127.0.0.1:${port}/api/items/${foreign.file.id}?include=derived`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      });
      const randomFile = await fetch(`http://127.0.0.1:${port}/api/items/${randomUUID()}?include=derived`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      });
      expect(foreignFile.status).toBe(404);
      expect(randomFile.status).toBe(404);
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
      if (runtimeWriter) {
        try {
          await runtimeWriter.end();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (failure) {
      if (cleanupErrors.length > 0)
        throw new AggregateError([failure.error, ...cleanupErrors], "Expansion REST fixture and cleanup failed");
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
