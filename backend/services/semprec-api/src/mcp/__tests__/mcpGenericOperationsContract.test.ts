import { ModuleRegistry } from "@semprec/module-registry";
import type { CollectionMetadataResolver } from "@semprec/data";
import { createItemWithClient, getDatabaseByModuleId, getSystemTimezone, today } from "@semprec/data";
import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createRuntimeRolePool,
  createTestTenant,
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  tenantForNextTestUser,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createDocStore,
  createRelationWithClient,
  createUser,
  createViewTypeRegistry,
  ensureJournalPeriodDoc,
  hashPassword,
  login,
  mintMcpRunCredential,
  insertValueLink,
  setInvalidationHook,
  type InvalidationEvent,
  seedSystem,
  withTransaction,
  type ChokePoint,
  type ItemRow,
  type PropertyRow,
  type ViewRow,
} from "@semprec/data";
import { createGenericOperationGateway, type GenericOperationGateway } from "@semprec/application";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import {
  CAPABILITY_IDS,
  GENERIC_OPERATION_NAMES,
  OPERATION_METADATA,
  runAsSystem,
  runInTenant,
  type CapabilityId,
  type GenericOperationName,
  type InputByOperation,
} from "@semprec/shared";
import { createMcpRequestListener } from "../mcpHandler.js";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({ icon: null, color: null, overviewOrder: null, switcherOrder: null, clientVisible: true }),
};

const PASSWORD = "s3cret-password";
const ALL_CAPABILITIES: ReadonlySet<CapabilityId> = new Set(CAPABILITY_IDS);
const DESTRUCTIVE_OPERATIONS: readonly GenericOperationName[] = GENERIC_OPERATION_NAMES.filter(
  (operation) => OPERATION_METADATA[operation].requiresApproval,
);

let pool: Pool;
let chokePoint: ChokePoint;
let gateway: GenericOperationGateway;

async function authHeader(): Promise<{ Authorization: string }> {
  const email = `${randomUUID()}@example.com`;
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

/**
 * Tenant zero's user, created on first use. A minted credential's run names its actor, and a run's
 * actor must be its own tenant's user (`agent_runs_actor_user_id_tenant_fkey`, issue #1066).
 */
async function tenantZeroUserId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1", [getTenantZeroId()]);
  return rows[0]?.id ?? (await createTenantZeroUser(pool)).id;
}

/** Mirrors `mcpHandler.test.ts`'s own `credentialHeader` — a restricted, single-run credential narrowed to exactly `capabilities`. */
async function credentialHeader(
  projectItemId: string,
  capabilities: CapabilityId[],
): Promise<{ Authorization: string }> {
  const userId = await tenantZeroUserId();
  const minted = await withTransaction(pool, (client) =>
    mintMcpRunCredential(client, { projectItemId, capabilities, userId }),
  );
  return { Authorization: `Bearer ${minted.token}` };
}

/** The Projects database row every `ai_agent` actor's `agentProjectItemId` is checked against (issue #87, `assertAuthenticatedAgentIdentity`). */
async function projectsDatabaseId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'projects'`);
  if (!rows[0]) throw new Error("Projects database was not seeded");
  return rows[0].id;
}

async function createProjectItem(): Promise<string> {
  const projectsDbId = await projectsDatabaseId();
  const item = await chokePoint.createItem({ databaseId: projectsDbId, properties: {} });
  return item.id;
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(
    await createMcpRequestListener(pool, gateway, ALL_CAPABILITIES, new ModuleRegistry(() => new Set())),
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: { content: { type: string; text: string }[] };
  error?: { code: number; message: string; data?: unknown };
}

async function rpc(
  baseUrl: string,
  headers: Record<string, string>,
  name: string,
  args: unknown,
): Promise<JsonRpcResponse> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as JsonRpcResponse;
}

interface Fixtures {
  database: { id: string };
  property: PropertyRow;
  itemA: ItemRow;
  itemB: ItemRow;
  view: ViewRow;
  /** The actor `view` was created by — every further `view`/`view_items` write in the same case must reuse it, since a mismatched actor either fails ownership or (for a 'user' write) silently adopts the view away from its agent creator. */
  viewActor: { type: "user" } | { type: "ai_agent"; agentProjectItemId: string };
  targetDatabase: { id: string };
  targetItem: ItemRow;
  relationProperty: PropertyRow;
  singleRelationProperty: PropertyRow;
}

/**
 * `agentProjectItemId`, when supplied, creates the view (and its initial membership) as that
 * `ai_agent` actor instead of the default `user` actor — required for the restricted-credential
 * loop below, since `assertViewWritable` (issue #87) rejects an agent actor's patch/membership
 * write to a view it did not itself create, regardless of capability grant.
 */
async function buildFixtures(agentProjectItemId?: string): Promise<Fixtures> {
  const viewActor =
    agentProjectItemId !== undefined ? { type: "ai_agent" as const, agentProjectItemId } : { type: "user" as const };
  const database = await chokePoint.createDatabase({ name: "MCP Contract DB" });
  const property = await chokePoint.createProperty({
    databaseId: database.id,
    key: "title",
    name: "Title",
    type: "text",
  });
  const itemA = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Arrival" } });
  const itemB = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Dune" } });
  const view = await chokePoint.createView(
    { type: "list", name: "Collection", config: { membership: "manual" } },
    viewActor,
  );
  await chokePoint.addViewItem({ viewId: view.id, itemId: itemA.id, position: 0, actor: viewActor });

  const targetDatabase = await chokePoint.createDatabase({ name: "MCP Contract Targets" });
  const targetItem = await chokePoint.createItem({ databaseId: targetDatabase.id, properties: {} });
  const { property: relationProperty } = await chokePoint.createRelationProperty({
    sourceDatabaseId: database.id,
    key: "assignedTo",
    name: "Assigned To",
    targetDatabaseId: targetDatabase.id,
    inverse: { key: "assignedFrom", name: "Assigned From" },
  });
  const { property: singleRelationProperty } = await chokePoint.createRelationProperty({
    sourceDatabaseId: database.id,
    key: "singleTarget",
    name: "Single target",
    targetDatabaseId: targetDatabase.id,
    cardinality: "one_to_one",
  });
  await chokePoint.createRelation({
    relationPropertyId: relationProperty.id,
    callerItemId: itemA.id,
    targetItemId: targetItem.id,
  });

  return {
    database,
    property,
    itemA,
    itemB,
    view,
    viewActor,
    targetDatabase,
    targetItem,
    relationProperty,
    singleRelationProperty,
  };
}

interface Case {
  /** The exact `tools/call` name/arguments a real MCP caller would send — MCP has no route layer to resolve a shorthand on its own, unlike REST's `:propertyKey` relation route. */
  tool: (fx: Fixtures) => { name: string; arguments: unknown };
  /** State a case needs already in place before its own operation runs — `restore`/`reorder` targets a row whose prior state (archived, deleted, already-positioned) the operation itself is not what creates. Applied directly through `chokePoint`, never through the tool under test. */
  prepare?: (fx: Fixtures) => Promise<void>;
}

/**
 * One `tools/call` case per operation in the closed 36-operation catalog, mirroring
 * `genericOperationsContract.test.ts`'s REST pattern one adapter over (the code-review finding on
 * issue #220's diff: parameterized contract tests across all of the then-28 operations were missing for the
 * MCP and AgentTool adapters). Reused across two describe-blocks below: dispatched by a plain
 * human-session actor (never approval-gated, matching `mcpHandler.test.ts`'s existing "no approval
 * gate for MCP actors" case) and by a restricted run-credential actor scoped to exactly the
 * operation's own capability (approval-gated for the 5 destructive operations).
 */
const CASES: Record<GenericOperationName, Case> = {
  "database.list": { tool: () => ({ name: "semprec.database.list", arguments: {} }) },
  "database.get": { tool: (fx) => ({ name: "semprec.database.get", arguments: { databaseId: fx.database.id } }) },
  "database.create": { tool: () => ({ name: "semprec.database.create", arguments: { name: "MCP Contract Create" } }) },
  "database.patch": {
    tool: (fx) => ({
      name: "semprec.database.patch",
      arguments: { databaseId: fx.database.id, patch: { name: "Renamed" } },
    }),
  },
  "database.archive": {
    tool: (fx) => ({ name: "semprec.database.archive", arguments: { databaseId: fx.database.id } }),
  },
  "database.restore": {
    tool: (fx) => ({ name: "semprec.database.restore", arguments: { databaseId: fx.database.id } }),
    prepare: async (fx) => {
      await chokePoint.archiveDatabase(fx.database.id);
    },
  },
  "property.list": { tool: (fx) => ({ name: "semprec.property.list", arguments: { databaseId: fx.database.id } }) },
  "property.get": { tool: (fx) => ({ name: "semprec.property.get", arguments: { propertyId: fx.property.id } }) },
  "property.getByKey": {
    tool: (fx) => ({
      name: "semprec.property.getByKey",
      arguments: { databaseId: fx.database.id, key: fx.relationProperty.key, type: "relation" },
    }),
  },
  "property.create": {
    tool: (fx) => ({
      name: "semprec.property.create",
      arguments: { databaseId: fx.database.id, key: "score", name: "Score", type: "number" },
    }),
  },
  "property.patch": {
    tool: (fx) => ({
      name: "semprec.property.patch",
      arguments: { propertyId: fx.property.id, patch: { name: "New Title" } },
    }),
  },
  "property.delete": {
    tool: (fx) => ({ name: "semprec.property.delete", arguments: { propertyId: fx.property.id } }),
  },
  "view.list": { tool: () => ({ name: "semprec.view.list", arguments: {} }) },
  "view.get": { tool: (fx) => ({ name: "semprec.view.get", arguments: { viewId: fx.view.id } }) },
  "view.create": {
    tool: (fx) => ({
      name: "semprec.view.create",
      arguments: { databaseId: fx.database.id, type: "table", name: "All rows" },
    }),
  },
  "view.patch": {
    tool: (fx) => ({ name: "semprec.view.patch", arguments: { viewId: fx.view.id, patch: { name: "Renamed view" } } }),
  },
  "view.delete": { tool: (fx) => ({ name: "semprec.view.delete", arguments: { viewId: fx.view.id } }) },
  "view.query": { tool: (fx) => ({ name: "semprec.view.query", arguments: { viewId: fx.view.id } }) },
  "viewItem.add": {
    tool: (fx) => ({
      name: "semprec.viewItem.add",
      arguments: { viewId: fx.view.id, itemId: fx.itemB.id, position: 1 },
    }),
  },
  "viewItem.remove": {
    tool: (fx) => ({ name: "semprec.viewItem.remove", arguments: { viewId: fx.view.id, itemId: fx.itemA.id } }),
  },
  "viewItem.reorder": {
    tool: (fx) => ({
      name: "semprec.viewItem.reorder",
      arguments: { viewId: fx.view.id, itemId: fx.itemB.id, position: 0 },
    }),
    prepare: async (fx) => {
      await chokePoint.addViewItem({ viewId: fx.view.id, itemId: fx.itemB.id, position: 1, actor: fx.viewActor });
    },
  },
  "item.get": { tool: (fx) => ({ name: "semprec.item.get", arguments: { itemId: fx.itemA.id } }) },
  "item.create": {
    tool: (fx) => ({
      name: "semprec.item.create",
      arguments: {
        databaseId: fx.database.id,
        properties: { title: "Contract Item" },
        relations: [{ propertyKey: fx.relationProperty.key, targetItemIds: [fx.targetItem.id] }],
      },
    }),
  },
  "item.patch": {
    tool: (fx) => ({
      name: "semprec.item.patch",
      arguments: { itemId: fx.itemA.id, properties: { title: "Updated" }, ifVersion: fx.itemA.updatedAt },
    }),
  },
  "item.delete": { tool: (fx) => ({ name: "semprec.item.delete", arguments: { itemId: fx.itemB.id } }) },
  "item.restore": {
    tool: (fx) => ({ name: "semprec.item.restore", arguments: { itemId: fx.itemB.id } }),
    prepare: async (fx) => {
      await chokePoint.softDeleteItem(fx.database.id, fx.itemB.id);
    },
  },
  "database.query": { tool: (fx) => ({ name: "semprec.database.query", arguments: { databaseId: fx.database.id } }) },
  "relation.put": {
    tool: (fx) => ({
      name: "semprec.relation.put",
      arguments: {
        relationPropertyId: fx.relationProperty.id,
        callerItemId: fx.itemB.id,
        targetItemId: fx.targetItem.id,
      },
    }),
  },
  "relation.set": {
    tool: (fx) => ({
      name: "semprec.relation.set",
      arguments: {
        relationPropertyId: fx.singleRelationProperty.id,
        callerItemId: fx.itemB.id,
        targetItemId: fx.targetItem.id,
      },
    }),
  },
  "relation.delete": {
    tool: (fx) => ({
      name: "semprec.relation.delete",
      arguments: {
        relationPropertyId: fx.relationProperty.id,
        callerItemId: fx.itemA.id,
        targetItemId: fx.targetItem.id,
      },
    }),
  },
  "relation.list": { tool: (fx) => ({ name: "semprec.relation.list", arguments: { itemId: fx.itemA.id } }) },
  "link.unlink": {
    tool: (fx) => ({ name: "semprec.link.unlink", arguments: { itemId: fx.itemA.id, propertyKey: "title" } }),
    prepare: async (fx) => {
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: fx.itemA.id,
          propertyKey: "title",
          ruleKey: "test",
          sources: [{ kind: "item", sourceItemId: fx.itemB.id, sourcePropertyKey: "title" }],
        }),
      );
    },
  },
  "link.relink": {
    tool: (fx) => ({ name: "semprec.link.relink", arguments: { itemId: fx.itemA.id, propertyKey: "title" } }),
    prepare: async (fx) => {
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
    },
  },
  "page.ensure": { tool: (fx) => ({ name: "semprec.page.ensure", arguments: { itemId: fx.itemA.id } }) },
  "page.get": { tool: (fx) => ({ name: "semprec.page.get", arguments: { itemId: fx.itemA.id, format: "summary" } }) },
  "page.restoreVersion": {
    // The block's update is dated an hour back, so the instant (half an hour back) sits inside the history `prepare` opens.
    tool: (fx) => ({
      name: "semprec.page.restoreVersion",
      arguments: { itemId: fx.itemA.id, at: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
    }),
    prepare: async (fx) => {
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
    },
  },
};

describe("generic operation MCP contract (issue #220)", () => {
  let servers: Server[] = [];

  it("sanitizes Emails.body on MCP item.get", async () => {
    const raw = '<p onclick="evil()">safe</p><script>evil()</script><img src="https://tracker.example/pixel">';
    const item = await withTransaction(pool, async (client) => {
      const database = await getDatabaseByModuleId(client, "emails");
      if (!database) throw new Error("Emails not seeded");
      return createItemWithClient(
        client,
        { databaseId: database.id, properties: { body: raw } },
        { allowedSystemKeys: ["body"] },
      );
    });

    const { server, baseUrl } = await startServer();
    servers.push(server);
    const body = await rpc(baseUrl, await authHeader(), "semprec.item.get", { itemId: item.id });
    expect(body.error).toBeUndefined();
    const text = body.result?.content.map((part) => part.text).join("");
    expect(text).toContain("safe");
    expect(text).not.toMatch(/<script|onclick|https:\/\/tracker/i);
  });
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    gateway = createGenericOperationGateway(pool, testMetadataResolver);
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("refuses a canvas as a page through MCP without changing its document", async () => {
    const fx = await buildFixtures();
    await createDocStore(pool).putCanvasElement(
      fx.itemA.id,
      { id: "shape", type: "shape", xywh: [0, 0, 10, 10], index: "a0" },
      "user",
    );
    const state = () =>
      pool.query(
        `SELECT to_jsonb(d) AS doc, to_jsonb(s) AS snapshot,
          (SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM doc_updates u WHERE u.doc_id = d.id) AS updates
         FROM docs d LEFT JOIN doc_snapshots s ON s.doc_id = d.id WHERE d.item_id = $1`,
        [fx.itemA.id],
      );
    const before = await state();
    expect(before.rows).toHaveLength(1);
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const result = await rpc(baseUrl, await authHeader(), "semprec.page.get", {
      itemId: fx.itemA.id,
      format: "summary",
    });
    expect(result.error).toMatchObject({ code: -32000, data: { code: "version_conflict" } });
    expect((await state()).rows).toEqual(before.rows);
  });

  it("ensures and reads the same page through a human MCP session", async () => {
    const fx = await buildFixtures();
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const headers = await authHeader();
    const content = (response: JsonRpcResponse): unknown => {
      expect(response.error).toBeUndefined();
      const text = response.result?.content[0]?.text;
      if (!text) throw new Error("Missing MCP output");
      return JSON.parse(text) as unknown;
    };
    const first = z
      .object({ docId: z.string() })
      .parse(content(await rpc(baseUrl, headers, "semprec.page.ensure", { itemId: fx.itemA.id })));
    expect(content(await rpc(baseUrl, headers, "semprec.page.ensure", { itemId: fx.itemA.id }))).toEqual(first);
    expect(
      content(await rpc(baseUrl, headers, "semprec.page.get", { itemId: fx.itemA.id, format: "summary" })),
    ).toMatchObject(first);
    expect((await pool.query("SELECT id FROM docs WHERE item_id = $1", [fx.itemA.id])).rows).toHaveLength(1);
  });

  it("validates Areas create and patch through MCP", async () => {
    const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
    if (!database) throw new Error("Areas not seeded");
    const item = await chokePoint.createItem({ databaseId: database.id, properties: { name: "Area" } });
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const headers = await authHeader();
    for (const [field, value] of [
      ["icon", "rocket123"],
      ["color", "#123456"],
    ] as const) {
      const created = await rpc(baseUrl, headers, "semprec.item.create", {
        databaseId: database.id,
        properties: { name: "Invalid", [field]: value },
      });
      expect(created.error).toMatchObject({ code: -32602, data: { field } });
      const updated = await rpc(baseUrl, headers, "semprec.item.patch", {
        itemId: item.id,
        properties: { [field]: value },
        ifVersion: item.updatedAt,
      });
      expect(updated.error).toMatchObject({ code: -32602, data: { field } });
    }
    const accepted = await rpc(baseUrl, headers, "semprec.item.patch", {
      itemId: item.id,
      properties: { icon: "briefcase", color: "#5856D6" },
      ifVersion: item.updatedAt,
    });
    expect(accepted.error).toBeUndefined();
    expect((await chokePoint.getItem(database.id, item.id))?.properties).toMatchObject({
      icon: "briefcase",
      color: "#5856D6",
    });
  });

  it("attributes MCP unlink to the agent and preserves the inherited value", async () => {
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
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const result = await rpc(baseUrl, await authHeader(), "semprec.link.unlink", {
      itemId: file.id,
      propertyKey: "projects",
    });
    expect(result.error).toBeUndefined();
    const text = result.result?.content[0]?.text;
    if (!text) throw new Error("Missing unlink output");
    const body: unknown = JSON.parse(text);
    expect(body).toMatchObject({
      itemId: file.id,
      propertyKey: "projects",
      valueKind: "inheritedBroken",
      brokenBy: "agent",
    });
    expect((await chokePoint.listItemRelations(file.id, property.id))?.map((edge) => edge.targetItemId)).toEqual([
      project.id,
    ]);
  });

  it("refuses deletion of the system area and filters it from MCP queries", async () => {
    const areas = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
    if (!areas) throw new Error("Areas missing");
    const list = await chokePoint.listItems(areas.id);
    const system = list.items.find((item) => item.properties.systemActive === true);
    if (!system) throw new Error("System area missing");
    const user = await chokePoint.createItem({ databaseId: areas.id, properties: { name: "User area" } });
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const headers = await authHeader();
    const deleted = await rpc(baseUrl, headers, "semprec.item.delete", { itemId: system.id });
    expect(deleted.error).toMatchObject({
      code: -32000,
      data: { code: "forbidden", details: { field: "systemActive" } },
    });
    expect(await chokePoint.getItem(areas.id, system.id)).toEqual(system);
    const queried = await rpc(baseUrl, headers, "semprec.database.query", {
      databaseId: areas.id,
      filter: { type: "is_empty", property: "systemActive" },
    });
    expect(queried.error).toBeUndefined();
    const text = queried.result?.content[0]?.text;
    if (!text) throw new Error("Missing query result");
    const body: unknown = JSON.parse(text);
    expect(body).toMatchObject({ items: [expect.objectContaining({ id: user.id })] });
    expect(text).not.toContain(system.id);
  });

  it("returns project completion in the MCP patch response and refuses direct writes", async () => {
    const databaseId = await projectsDatabaseId();
    const item = await chokePoint.createItem({ databaseId, properties: { name: "Project", status: "inProgress" } });
    const day = today(await withTransaction(pool, getSystemTimezone));
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const headers = await authHeader();
    const result = await rpc(baseUrl, headers, "semprec.item.patch", {
      itemId: item.id,
      properties: { status: "done" },
      ifVersion: item.updatedAt,
    });
    expect(result.error).toBeUndefined();
    const text = result.result?.content[0]?.text;
    if (!text) throw new Error("Missing MCP patch result");
    const resultBody: unknown = JSON.parse(text);
    expect(resultBody).toMatchObject({ properties: { status: "done", completedAt: day } });
    const current = await chokePoint.getItem(databaseId, item.id);
    if (!current) throw new Error("Missing project");
    const refused = await rpc(baseUrl, headers, "semprec.item.patch", {
      itemId: item.id,
      properties: { completedAt: "2000-01-01" },
      ifVersion: current.updatedAt,
    });
    expect(refused.error).toBeDefined();
    expect((await chokePoint.getItem(databaseId, item.id))?.properties.completedAt).toBe(day);
  });

  it("keeps and restores project deadlines through MCP", async () => {
    const databaseId = await projectsDatabaseId();
    const item = await chokePoint.createItem({
      databaseId,
      properties: { name: "Project", status: "inProgress", date: "2026-11-30" },
    });
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const headers = await authHeader();
    const patch = async (properties: Record<string, unknown>) => {
      const current = await chokePoint.getItem(databaseId, item.id);
      if (!current) throw new Error("Missing project");
      return rpc(baseUrl, headers, "semprec.item.patch", { itemId: item.id, properties, ifVersion: current.updatedAt });
    };
    expect((await patch({ status: "longTerm" })).error).toBeUndefined();
    expect((await chokePoint.getItem(databaseId, item.id))?.properties.date).toBeNull();
    expect((await patch({ date: "2027-01-01" })).error).toMatchObject({ code: -32602, data: { field: "date" } });
    expect((await patch({ status: "inProgress" })).error).toBeUndefined();
    expect((await chokePoint.getItem(databaseId, item.id))?.properties.date).toBe("2026-11-30");
  });

  it("attributes session MCP relation deletion to its authenticated user", async () => {
    const fx = await buildFixtures();
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: fx.itemA.id,
        propertyKey: fx.relationProperty.key,
        ruleKey: "test",
        sources: [],
      }),
    );
    const user = await createUser(pool, {
      tenantId: await tenantForNextTestUser(pool),
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      const result = await rpc(baseUrl, { Authorization: `Bearer ${token}` }, "semprec.relation.delete", {
        relationPropertyId: fx.relationProperty.id,
        callerItemId: fx.itemA.id,
        targetItemId: fx.targetItem.id,
      });
      expect(result.error).toBeUndefined();
      expect(events.filter((event) => event.scope === "item" && event.itemId === fx.itemA.id)).toEqual([
        expect.objectContaining({ userId: user.id }),
      ]);
    } finally {
      setInvalidationHook(() => {});
    }
  });

  it.each(["done", "archived"])("unpins Projects and refuses explicit terminal pins over MCP (%s)", async (status) => {
    const databaseId = await projectsDatabaseId();
    const item = await chokePoint.createItem({
      databaseId,
      properties: { name: "Project", status: "inProgress", pinned: true },
    });
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const headers = await authHeader();
    async function patchProject(properties: Record<string, unknown>) {
      const current = await chokePoint.getItem(databaseId, item.id);
      if (!current) throw new Error("Missing project fixture");
      const args: InputByOperation["item.patch"] = { itemId: item.id, properties, ifVersion: current.updatedAt };
      return rpc(baseUrl, headers, "semprec.item.patch", args);
    }
    const answer = await patchProject({ status });
    expect(answer.error).toBeUndefined();
    const content = answer.result?.content.find((part) => part.type === "text")?.text;
    if (!content) throw new Error("Missing MCP result");
    const result: unknown = JSON.parse(content);
    expect(result).toMatchObject({ properties: { status, pinned: false } });
    for (const patch of [{ pinned: true }, { status, pinned: true }]) {
      const rejected = await patchProject(patch);
      expect(rejected.error?.code).toBe(-32602);
      expect(rejected.error?.data).toMatchObject({ field: "pinned" });
      expect((await chokePoint.getItem(databaseId, item.id))?.properties).toMatchObject({ status, pinned: false });
    }
    for (const activeStatus of ["inProgress", "longTerm"]) {
      const accepted = await patchProject({ status: activeStatus, pinned: true });
      expect(accepted.error).toBeUndefined();
      expect((await chokePoint.getItem(databaseId, item.id))?.properties).toMatchObject({
        status: activeStatus,
        pinned: true,
      });
    }
    const combined = await patchProject({ status, pinned: true });
    expect(combined.error?.code).toBe(-32602);
    expect(combined.error?.data).toMatchObject({ field: "pinned" });
    expect((await chokePoint.getItem(databaseId, item.id))?.properties).toMatchObject({
      status: "longTerm",
      pinned: true,
    });
  });

  it("has exactly one contract case per operation in the closed catalog", () => {
    expect(Object.keys(CASES).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
  });

  it("lists relation.set and both link operations for a human session", async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "semprec.relation.set" }),
          expect.objectContaining({ name: "semprec.link.unlink" }),
          expect.objectContaining({ name: "semprec.link.relink" }),
        ]),
      },
    });
  });

  it("refuses link operations without item write capability through MCP", async () => {
    const projectItemId = await createProjectItem();
    const fx = await buildFixtures(projectItemId);
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: fx.itemA.id,
        propertyKey: "title",
        ruleKey: "test",
        sources: [{ kind: "item", sourceItemId: fx.itemB.id, sourcePropertyKey: "title" }],
      }),
    );
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const headers = await credentialHeader(projectItemId, ["core.item.read"]);
    const before = await chokePoint.getItem(fx.database.id, fx.itemA.id);
    const linksBefore = await chokePoint.getValueLinksForItems([fx.itemA.id]);
    for (const name of ["semprec.link.unlink", "semprec.link.relink"]) {
      const response = await rpc(baseUrl, headers, name, { itemId: fx.itemA.id, propertyKey: "title" });
      expect(response.error).toMatchObject({ code: -32601 });
    }
    expect(await chokePoint.getItem(fx.database.id, fx.itemA.id)).toEqual(before);
    expect(await chokePoint.getValueLinksForItems([fx.itemA.id])).toEqual(linksBefore);
  });

  it("executes relation.set and item.create through MCP under tenant RLS", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let server: Server | undefined;
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
      const user = await runAsSystem("test:create-mcp-user", () =>
        createUser(pool, {
          tenantId: ownTenant,
          email: `${randomUUID()}@example.test`,
          passwordHash: "unused-test-hash",
        }),
      );
      const cp = createChokePoint(runtime);
      async function fixture(tenantId: string) {
        return runInTenant(tenantId, async () => {
          await seedSystem(runtime, createViewTypeRegistry());
          const source = await cp.createDatabase({ name: "MCP runtime source" });
          const target = await cp.createDatabase({ name: "MCP runtime target" });
          const { property } = await cp.createRelationProperty({
            sourceDatabaseId: source.id,
            targetDatabaseId: target.id,
            key: "link",
            name: "Link",
            cardinality: "one_to_one",
          });
          const caller = await cp.createItem({ databaseId: source.id, properties: {} });
          const first = await cp.createItem({ databaseId: target.id, properties: {} });
          const second = await cp.createItem({ databaseId: target.id, properties: {} });
          const third = await cp.createItem({ databaseId: target.id, properties: {} });
          await cp.setRelation({ relationPropertyId: property.id, callerItemId: caller.id, targetItemId: first.id });
          return { source, target, property, caller, second, third };
        });
      }
      const own = await fixture(ownTenant);
      const foreign = await fixture(foreignTenant);
      const credential = await runInTenant(ownTenant, async () => {
        const projects = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "projects"));
        if (!projects) throw new Error("Missing projects database");
        const project = await cp.createItem({ databaseId: projects.id, properties: { name: "MCP runtime agent" } });
        return withTransaction(runtime, (client) =>
          mintMcpRunCredential(client, {
            projectItemId: project.id,
            capabilities: ["core.item.write"],
            userId: user.id,
          }),
        );
      });
      const runtimeGateway = createGenericOperationGateway(runtime, testMetadataResolver);
      server = createServer(
        await createMcpRequestListener(runtime, runtimeGateway, ALL_CAPABILITIES, new ModuleRegistry(() => new Set())),
      );
      const ownedServer = server;
      await new Promise<void>((resolve, reject) => {
        ownedServer.once("error", reject);
        ownedServer.listen(0, "127.0.0.1", () => {
          ownedServer.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing MCP runtime address");
      const port = address.port;
      const schema = z.object({
        result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) }).optional(),
        error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
      });
      async function call(name: string, args: unknown) {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        });
        expect(response.status).toBe(200);
        return schema.parse(await response.json());
      }
      const moved = await call("semprec.relation.set", {
        relationPropertyId: own.property.id,
        callerItemId: own.caller.id,
        targetItemId: own.second.id,
      });
      expect(moved.error).toBeUndefined();
      expect(moved.result?.content).toHaveLength(1);
      expect(await runInTenant(ownTenant, () => cp.listItemRelations(own.caller.id, own.property.id))).toMatchObject([
        { targetItemId: own.second.id },
      ]);
      const created = await call("semprec.item.create", {
        databaseId: own.source.id,
        properties: {},
        relations: [{ propertyKey: "link", targetItemIds: [own.third.id] }],
      });
      expect(created.error).toBeUndefined();
      const content = created.result?.content[0]?.text;
      if (!content) throw new Error("Missing MCP create result");
      const parsed = z.object({ id: z.string().uuid() }).parse(JSON.parse(content));
      expect(await runInTenant(ownTenant, () => cp.listItemRelations(parsed.id, own.property.id))).toMatchObject([
        { targetItemId: own.third.id },
      ]);
      const fileFixture = await runInTenant(ownTenant, async () => {
        const files = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files"));
        const projects = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "projects"));
        if (!files || !projects) throw new Error("Missing Files or Projects database");
        const property = (await cp.listProperties(files.id)).find((entry) => entry.key === "projects");
        if (!property) throw new Error("Missing Files.projects relation");
        const project = await cp.createItem({ databaseId: projects.id, properties: { name: "File project" } });
        return { files, property, project };
      });
      const file = await call("semprec.item.create", {
        databaseId: fileFixture.files.id,
        properties: { name: "Linked file" },
        relations: [{ propertyKey: "projects", targetItemIds: [fileFixture.project.id] }],
      });
      expect(file.error).toBeUndefined();
      const fileContent = file.result?.content[0]?.text;
      if (!fileContent) throw new Error("Missing MCP file result");
      const fileResult = z.object({ id: z.string().uuid() }).parse(JSON.parse(fileContent));
      expect(
        await runInTenant(ownTenant, () => cp.listItemRelations(fileResult.id, fileFixture.property.id)),
      ).toMatchObject([{ targetItemId: fileFixture.project.id }]);
      async function snapshot(tenantId: string) {
        return runInTenant(tenantId, async () => {
          const items = await runtime.query<{
            id: string;
            database_id: string;
            properties: unknown;
            computed: unknown;
            deleted_at: Date | null;
            updated_at: Date;
          }>("SELECT id, database_id, properties, computed, deleted_at, updated_at FROM items ORDER BY id");
          const edges = await runtime.query<{ id: string; item_a: string; item_b: string }>(
            "SELECT id, item_a, item_b FROM item_relations ORDER BY id",
          );
          const approvals = await runtime.query<{ id: string; status: string }>(
            "SELECT id, status FROM approval_requests ORDER BY id",
          );
          return { items: items.rows, edges: edges.rows, approvals: approvals.rows };
        });
      }
      const ownBefore = await snapshot(ownTenant);
      const foreignBefore = await snapshot(foreignTenant);
      const relationInProperties = await call("semprec.item.create", {
        databaseId: own.source.id,
        properties: { link: own.third.id },
        relations: [{ propertyKey: "link", targetItemIds: [own.third.id] }],
      });
      expect(relationInProperties.error).toMatchObject({ code: -32602, data: { field: "link" } });
      expect(await snapshot(ownTenant)).toEqual(ownBefore);
      expect(await snapshot(foreignTenant)).toEqual(foreignBefore);
      const missing = randomUUID();
      for (const operation of ["relation.set", "item.create"] as const) {
        const invoke = (targetItemId: string) =>
          operation === "relation.set"
            ? call("semprec.relation.set", {
                relationPropertyId: own.property.id,
                callerItemId: own.caller.id,
                targetItemId,
              })
            : call("semprec.item.create", {
                databaseId: own.source.id,
                properties: {},
                relations: [{ propertyKey: "link", targetItemIds: [targetItemId] }],
              });
        const denied = await invoke(foreign.third.id);
        const absent = await invoke(missing);
        expect(denied.error).toBeDefined();
        expect(absent.error).toBeDefined();
        if (!denied.error || !absent.error) throw new Error("Expected MCP refusals");
        expect(JSON.stringify(denied.error).replaceAll(foreign.third.id, "<target>")).toBe(
          JSON.stringify(absent.error).replaceAll(missing, "<target>"),
        );
        expect(await snapshot(ownTenant)).toEqual(ownBefore);
        expect(await snapshot(foreignTenant)).toEqual(foreignBefore);
      }
      const replayTarget = await runInTenant(ownTenant, async () => {
        await cp.createProperty({ databaseId: own.source.id, key: "scalar", name: "Scalar", type: "text" });
        return cp.createItem({ databaseId: own.target.id, properties: {} });
      });
      const idempotencyKey = randomUUID();
      const replayArgs = {
        databaseId: own.source.id,
        properties: {},
        idempotencyKey,
        relations: [{ propertyKey: "link", targetItemIds: [replayTarget.id] }],
      };
      const original = await call("semprec.item.create", replayArgs);
      expect(original.error).toBeUndefined();
      const originalText = original.result?.content[0]?.text;
      if (!originalText) throw new Error("Missing original MCP item");
      const originalItem = z.object({ id: z.string().uuid() }).parse(JSON.parse(originalText));
      expect(await runInTenant(ownTenant, () => cp.listItemRelations(originalItem.id, own.property.id))).toMatchObject([
        { targetItemId: replayTarget.id },
      ]);
      await runInTenant(ownTenant, () => cp.deleteProperty(own.property.id));
      expect(await runInTenant(ownTenant, () => cp.listProperties(own.source.id))).not.toContainEqual(
        expect.objectContaining({ id: own.property.id }),
      );
      const afterDelete = await snapshot(ownTenant);
      const foreignAfterDelete = await snapshot(foreignTenant);
      async function jobs() {
        const result = await pool.query<{ snapshot: string; task_identifier: string }>(
          "SELECT row_to_json(j)::text AS snapshot, task_identifier FROM graphile_worker.jobs j ORDER BY id",
        );
        const payloads: Record<string, string[]> = {};
        for (const identifier of new Set(result.rows.map((row) => row.task_identifier))) {
          payloads[identifier] = (await readJobPayloadsByIdentifier(pool, identifier))
            .map((value) =>
              createHash("sha256")
                .update(JSON.stringify(value) ?? "undefined")
                .digest("hex"),
            )
            .sort();
        }
        return { rows: result.rows, payloads };
      }
      const jobsAfterDelete = await jobs();
      for (const propertyKey of ["link", "scalar"]) {
        const replay = await call("semprec.item.create", {
          ...replayArgs,
          relations: [{ propertyKey, targetItemIds: [replayTarget.id] }],
        });
        expect(replay.error).toBeUndefined();
        const text = replay.result?.content[0]?.text;
        if (!text) throw new Error("Missing MCP replay item");
        expect(z.object({ id: z.string().uuid() }).parse(JSON.parse(text)).id).toBe(originalItem.id);
        expect(await snapshot(ownTenant)).toEqual(afterDelete);
        expect(await snapshot(foreignTenant)).toEqual(foreignAfterDelete);
        expect(await jobs()).toEqual(jobsAfterDelete);
        const fresh = await call("semprec.item.create", {
          ...replayArgs,
          idempotencyKey: randomUUID(),
          relations: [{ propertyKey, targetItemIds: [replayTarget.id] }],
        });
        expect(fresh.error).toMatchObject({ code: -32602, data: { field: "relations" } });
        expect(await snapshot(ownTenant)).toEqual(afterDelete);
        expect(await snapshot(foreignTenant)).toEqual(foreignAfterDelete);
        expect(await jobs()).toEqual(jobsAfterDelete);
      }
    } catch (error) {
      failure = { error };
    } finally {
      if (server?.listening) {
        const ownedServer = server;
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
      if (cleanupErrors.length > 0) console.error("MCP runtime fixture cleanup also failed");
      throw failure.error;
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "MCP runtime fixture cleanup failed");
  });

  it("refuses a run credential's generic Journal events writes with owner_violation under tenant RLS (gh-1609, gh-2016)", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let server: Server | undefined;
    let failure: { error: unknown } | undefined;
    const cleanupErrors: unknown[] = [];
    try {
      const role = await runAsSystem("test:verify-runtime-role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const ownTenant = await createTestTenant(pool);
      const foreignTenant = await createTestTenant(pool);
      const user = await runAsSystem("test:create-mcp-user", () =>
        createUser(pool, {
          tenantId: ownTenant,
          email: `${randomUUID()}@example.test`,
          passwordHash: "unused-test-hash",
        }),
      );
      const cp = createChokePoint(runtime);
      async function fixture(tenantId: string) {
        return runInTenant(tenantId, async () => {
          await seedSystem(runtime, createViewTypeRegistry());
          const database = async (moduleId: string) => {
            const found = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, moduleId));
            if (!found) throw new Error(`Missing ${moduleId} database`);
            return found;
          };
          const journal = await database("journal");
          const relationProperty = async (key: string) => {
            const found = (await cp.listProperties(journal.id)).find((entry) => entry.key === key);
            if (!found) throw new Error(`Missing Journal.${key}`);
            return found;
          };
          const events = await relationProperty("events");
          const project = await relationProperty("project");
          if (events.ownerProcess === null) throw new Error("Journal.events has no owner process");
          const day = await withTransaction(runtime, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-16"));
          const eventsDb = await database("events");
          const standup = await cp.createItem({
            databaseId: eventsDb.id,
            properties: { name: "Standup", date: "2026-10-16" },
          });
          const linked = await cp.createItem({
            databaseId: eventsDb.id,
            properties: { name: "Retro", date: "2026-10-16" },
          });
          const projectItem = await cp.createItem({
            databaseId: (await database("projects")).id,
            properties: { name: "Journal project" },
          });
          // The derived edge as its owning process (the event-link sync) writes it, through the system choke point.
          const ownerProcess = events.ownerProcess;
          await withTransaction(runtime, (client) =>
            createRelationWithClient(
              client,
              { relationPropertyId: events.id, callerItemId: day.itemId, targetItemId: linked.id },
              { ownerProcess },
            ),
          );
          return { events, project, day: day.itemId, standup, linked, projectItem };
        });
      }
      const own = await fixture(ownTenant);
      const foreign = await fixture(foreignTenant);
      const credential = await runInTenant(ownTenant, async () => {
        const projects = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "projects"));
        if (!projects) throw new Error("Missing projects database");
        const agent = await cp.createItem({ databaseId: projects.id, properties: { name: "Journal agent" } });
        return withTransaction(runtime, (client) =>
          mintMcpRunCredential(client, { projectItemId: agent.id, capabilities: ["core.item.write"], userId: user.id }),
        );
      });
      const runtimeGateway = createGenericOperationGateway(runtime, testMetadataResolver);
      server = createServer(
        await createMcpRequestListener(runtime, runtimeGateway, ALL_CAPABILITIES, new ModuleRegistry(() => new Set())),
      );
      const ownedServer = server;
      await new Promise<void>((resolve, reject) => {
        ownedServer.once("error", reject);
        ownedServer.listen(0, "127.0.0.1", () => {
          ownedServer.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing MCP runtime address");
      const port = address.port;
      const schema = z.object({
        result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) }).optional(),
        error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
      });
      async function call(name: string, args: unknown) {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        });
        expect(response.status).toBe(200);
        return schema.parse(await response.json());
      }
      async function snapshot(tenantId: string) {
        return runInTenant(tenantId, async () => {
          const edges = await runtime.query<{ id: string; item_a: string; item_b: string }>(
            "SELECT id, item_a, item_b FROM item_relations ORDER BY id",
          );
          const approvals = await runtime.query<{ id: string; status: string }>(
            "SELECT id, status FROM approval_requests ORDER BY id",
          );
          return { edges: edges.rows, approvals: approvals.rows };
        });
      }
      const targets = (property: { id: string }) =>
        runInTenant(ownTenant, async () =>
          ((await cp.listItemRelations(own.day, property.id)) ?? []).map((edge) => edge.targetItemId),
        );
      expect(await targets(own.events)).toEqual([own.linked.id]);
      const ownBefore = await snapshot(ownTenant);
      const foreignBefore = await snapshot(foreignTenant);

      const invalidations: InvalidationEvent[] = [];
      setInvalidationHook((event) => invalidations.push(event));
      for (const [name, targetItemId] of [
        ["semprec.relation.put", own.standup.id],
        ["semprec.relation.delete", own.linked.id],
      ] as const) {
        const refused = await call(name, { relationPropertyId: own.events.id, callerItemId: own.day, targetItemId });
        expect(refused.result).toBeUndefined();
        expect(refused.error).toMatchObject({ code: -32000, data: { code: "owner_violation" } });
      }
      setInvalidationHook(() => {});
      expect(invalidations).toEqual([]);
      expect(await snapshot(ownTenant)).toEqual(ownBefore);
      expect(await snapshot(foreignTenant)).toEqual(foreignBefore);

      // The same credential writes the user-owned Journal `project` relation, and its delete reaches the approval gate:
      // the refusals above are the relation's ownership, not a missing grant or the approval requirement.
      const put = await call("semprec.relation.put", {
        relationPropertyId: own.project.id,
        callerItemId: own.day,
        targetItemId: own.projectItem.id,
      });
      expect(put.error).toBeUndefined();
      expect(await targets(own.project)).toEqual([own.projectItem.id]);
      const removal = await call("semprec.relation.delete", {
        relationPropertyId: own.project.id,
        callerItemId: own.day,
        targetItemId: own.projectItem.id,
      });
      expect(removal.error?.code).toBe(-32001);
      expect((await snapshot(ownTenant)).approvals).toEqual([{ id: expect.any(String), status: "pending" }]);
      expect(await targets(own.project)).toEqual([own.projectItem.id]);
      expect(await targets(own.events)).toEqual([own.linked.id]);

      const crossTenant = await call("semprec.relation.put", {
        relationPropertyId: foreign.events.id,
        callerItemId: foreign.day,
        targetItemId: foreign.standup.id,
      });
      const unknown = await call("semprec.relation.put", {
        relationPropertyId: randomUUID(),
        callerItemId: randomUUID(),
        targetItemId: randomUUID(),
      });
      expect(crossTenant.result).toBeUndefined();
      expect(crossTenant.error?.code).toBe(unknown.error?.code);
      expect(crossTenant.error?.data).toEqual(unknown.error?.data);
      expect(await snapshot(foreignTenant)).toEqual(foreignBefore);
    } catch (error) {
      failure = { error };
    } finally {
      setInvalidationHook(() => {});
      if (server?.listening) {
        const ownedServer = server;
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
      if (cleanupErrors.length > 0) console.error("MCP Journal events fixture cleanup also failed");
      throw failure.error;
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "MCP Journal events fixture cleanup failed");
  });

  it("creates the requested initial relation through MCP", async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const fx = await buildFixtures();
    const { name, arguments: args } = CASES["item.create"].tool(fx);
    const response = await rpc(baseUrl, await authHeader(), name, args);
    expect(response.error).toBeUndefined();
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND properties->>'title' = $2",
      [fx.database.id, "Contract Item"],
    );
    expect(rows).toHaveLength(1);
    const created = rows[0];
    if (!created) throw new Error("Expected created item");
    expect(await chokePoint.listItemRelations(created.id, fx.relationProperty.id)).toMatchObject([
      { targetItemId: fx.targetItem.id },
    ]);
  });

  it("forbids MCP database creation with properties but permits a bare create", async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const headers = await authHeader();
    const footprint = async () =>
      (
        await pool.query<{ databases: number; properties: number; partitions: number }>(
          "SELECT (SELECT count(*)::int FROM databases) AS databases, (SELECT count(*)::int FROM properties) AS properties, (SELECT count(*)::int FROM pg_class WHERE relname LIKE 'items\\_p\\_%') AS partitions",
        )
      ).rows;
    const before = await footprint();
    const rejected = await rpc(baseUrl, headers, "semprec.database.create", {
      name: "MCP with properties",
      properties: [{ key: "note", name: "Note", type: "text" }],
    });
    expect(rejected.error?.code).toBe(-32000);
    expect(rejected.error?.data).toMatchObject({ code: "forbidden" });
    expect(await footprint()).toEqual(before);
    const bare = await rpc(baseUrl, headers, "semprec.database.create", { name: "MCP bare" });
    expect(bare.error).toBeUndefined();
    expect((await chokePoint.listDatabases()).some((database) => database.name === "MCP bare")).toBe(true);
  });

  it.each(["relation.list", "page.restoreVersion"] as const)(
    "rejects malformed %s item IDs at the MCP boundary",
    async (operation) => {
      const { server, baseUrl } = await startServer();
      servers.push(server);
      const args =
        operation === "relation.list"
          ? { itemId: "not-a-uuid" }
          : { itemId: "not-a-uuid", at: new Date().toISOString() };
      const response = await rpc(baseUrl, await authHeader(), `semprec.${operation}`, args);
      expect(response.error?.code).toBe(-32602);
      expect(response.error?.data).toMatchObject({ field: "itemId" });
    },
  );

  it("rejects an empty database patch at the MCP operation boundary", async () => {
    const database = await chokePoint.createDatabase({ name: "MCP patch fixture" });
    const { server, baseUrl } = await startServer();
    servers.push(server);
    const response = await rpc(baseUrl, await authHeader(), "semprec.database.patch", {
      databaseId: database.id,
      patch: {},
    });
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.data).toMatchObject({ reason: "empty_patch" });
    expect((await chokePoint.getDatabase(database.id))?.name).toBe("MCP patch fixture");
  });

  describe("dispatch through a plain human-session actor", () => {
    for (const operation of GENERIC_OPERATION_NAMES) {
      it(`dispatches ${operation} through the MCP adapter`, async () => {
        const { server, baseUrl } = await startServer();
        servers.push(server);
        const fx = await buildFixtures();
        const testCase = CASES[operation];
        await testCase.prepare?.(fx);
        const { name, arguments: args } = testCase.tool(fx);

        const body = await rpc(baseUrl, await authHeader(), name, args);

        expect(body.error).toBeUndefined();
      });
    }
  });

  describe("approval gate for a restricted run-credential actor", () => {
    for (const operation of GENERIC_OPERATION_NAMES) {
      const isDestructive = DESTRUCTIVE_OPERATIONS.includes(operation);
      it(`${isDestructive ? "queues an approval request for" : "executes"} ${operation}`, async () => {
        const { server, baseUrl } = await startServer();
        servers.push(server);
        const projectItemId = await createProjectItem();
        const fx = await buildFixtures(projectItemId);
        const testCase = CASES[operation];
        await testCase.prepare?.(fx);
        const { name, arguments: args } = testCase.tool(fx);
        const headers = await credentialHeader(projectItemId, [OPERATION_METADATA[operation].requiresCapability]);

        const body = await rpc(baseUrl, headers, name, args);

        if (isDestructive) {
          expect(body.error?.code).toBe(-32001);
          const { rows } = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM approval_requests`);
          expect(rows[0]!.count).toBe(1);
        } else {
          expect(body.error).toBeUndefined();
        }
      });
    }
  });

  /**
   * The four parity cases the code-review finding on issue #220's diff called out by name
   * (`database_archived`, actor schema parity, relation type/config patch rejection, relation
   * route resolution vs. direct `relationPropertyId` supply) — REST already covers each in
   * `itemsHandler.test.ts`/`propertiesHandler.test.ts`; these are their MCP-adapter equivalents.
   */
  describe("issue #220 REST/MCP parity: database_archived, actor spoofing, relation patch rejection", () => {
    it("surfaces database_archived (issue #83) as a JSON-RPC -32000 for a write against an archived database", async () => {
      const { server, baseUrl } = await startServer();
      servers.push(server);
      const fx = await buildFixtures();
      await chokePoint.archiveDatabase(fx.database.id);

      const body = await rpc(baseUrl, await authHeader(), "semprec.item.create", {
        databaseId: fx.database.id,
        properties: { title: "Arrival" },
      });

      expect(body.error?.code).toBe(-32000);
      expect((body.error?.data as { code?: string } | undefined)?.code).toBe("database_archived");
    });

    it("rejects an actor-identity-shaped field smuggled into tool arguments with -32602", async () => {
      const { server, baseUrl } = await startServer();
      servers.push(server);
      const fx = await buildFixtures();

      // Every generic-operation input schema is a strict zod object (see `schemas.ts`) with none
      // of `AuthenticatedActor`'s own field names — an attempt to smuggle a different identity in
      // through `arguments` fails validation rather than silently being ignored or honored.
      const body = await rpc(baseUrl, await authHeader(), "semprec.view.create", {
        databaseId: fx.database.id,
        type: "table",
        name: "Stolen view",
        agentProjectItemId: randomUUID(),
        runId: randomUUID(),
        userId: randomUUID(),
      });

      expect(body.error?.code).toBe(-32602);
    });

    it("rejects patch.type on a relation property with -32602 validation_failed relation_definition_required (issue #219)", async () => {
      const { server, baseUrl } = await startServer();
      servers.push(server);
      const fx = await buildFixtures();

      const body = await rpc(baseUrl, await authHeader(), "semprec.property.patch", {
        propertyId: fx.relationProperty.id,
        patch: { type: "text" },
      });

      expect(body.error?.code).toBe(-32602);
      expect(body.error?.data).toMatchObject({ field: "type", reason: "relation_definition_required" });
    });

    it("rejects patch.config on a relation property with -32602 validation_failed relation_definition_required (issue #219)", async () => {
      const { server, baseUrl } = await startServer();
      servers.push(server);
      const fx = await buildFixtures();

      const body = await rpc(baseUrl, await authHeader(), "semprec.property.patch", {
        propertyId: fx.relationProperty.id,
        patch: { config: { note: "x" } },
      });

      expect(body.error?.code).toBe(-32602);
      expect(body.error?.data).toMatchObject({ field: "config", reason: "relation_definition_required" });
    });

    it("rejects a non-relation property id supplied directly as relationPropertyId — contrast with REST's key-based route resolution", async () => {
      const { server, baseUrl } = await startServer();
      servers.push(server);
      const fx = await buildFixtures();

      // REST resolves a relation route's `:propertyKey` segment against the caller item's own
      // database (`resolveRelationProperty` in `itemsHandler.ts`) and 404s for no match. MCP has
      // no route layer: it takes `relationPropertyId` directly and the choke point rejects a
      // syntactically valid id that doesn't name a relation property, rather than resolving it.
      const body = await rpc(baseUrl, await authHeader(), "semprec.relation.put", {
        relationPropertyId: fx.property.id,
        callerItemId: fx.itemA.id,
        targetItemId: fx.targetItem.id,
      });

      expect(body.error?.code).toBe(-32602);
      expect(body.error?.data).toMatchObject({ field: "relationPropertyId" });
    });
  });
});
