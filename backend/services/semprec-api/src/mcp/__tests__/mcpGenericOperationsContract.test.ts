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
  REST_ONLY_OPERATION_NAMES,
  runAsSystem,
  runInTenant,
  type CapabilityId,
  type GenericOperationName,
  type InputByOperation,
} from "@semprec/shared";
import { createMcpRequestListener } from "../mcpHandler.js";

const testMetadataResolver: CollectionMetadataResolver = {
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
};

const PASSWORD = "s3cret-password";
const ALL_CAPABILITIES: ReadonlySet<CapabilityId> = new Set(CAPABILITY_IDS);
const DESTRUCTIVE_OPERATIONS: readonly GenericOperationName[] = GENERIC_OPERATION_NAMES.filter(
  (operation) => OPERATION_METADATA[operation].requiresApproval,
);

/**
 * Their fixture holds an active value link they end, so an agent run credential is asked for
 * approval.
 */
const LINK_ENDING_OPERATIONS: readonly GenericOperationName[] = ["link.unlink"];

let pool: Pool;
let chokePoint: ChokePoint;
let gateway: GenericOperationGateway;
let servers: Server[] = [];

type Headers = Record<string, string>;

async function sessionUser(): Promise<{ id: string; headers: Headers }> {
  const email = `${randomUUID()}@example.com`;
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { id: user.id, headers: { Authorization: `Bearer ${token}` } };
}

async function authHeader(): Promise<Headers> {
  return (await sessionUser()).headers;
}

/**
 * Created on first use. A run's actor must be a user of its own tenant
 * (`agent_runs_actor_user_id_tenant_fkey`).
 */
async function tenantZeroUserId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1", [getTenantZeroId()]);
  return rows[0]?.id ?? (await createTenantZeroUser(pool)).id;
}

/** A single-run credential narrowed to exactly `capabilities`. */
async function credentialHeader(projectItemId: string, capabilities: CapabilityId[]): Promise<Headers> {
  const userId = await tenantZeroUserId();
  const minted = await withTransaction(pool, (client) =>
    mintMcpRunCredential(client, { projectItemId, capabilities, userId }),
  );
  return { Authorization: `Bearer ${minted.token}` };
}

async function moduleDatabase(moduleId: string, db: Pool = pool): Promise<{ id: string }> {
  const found = await withTransaction(db, (client) => getDatabaseByModuleId(client, moduleId));
  if (!found) throw new Error(`${moduleId} database was not seeded`);
  return found;
}

/** An item of the database every `ai_agent` actor's `agentProjectItemId` is checked against. */
async function createProjectItem(): Promise<string> {
  const projects = await moduleDatabase("projects");
  return (await chokePoint.createItem({ databaseId: projects.id, properties: {} })).id;
}

async function listen(listenerPool: Pool, listenerGateway: GenericOperationGateway): Promise<string> {
  const server = createServer(
    await createMcpRequestListener(
      listenerPool,
      listenerGateway,
      ALL_CAPABILITIES,
      new ModuleRegistry(() => new Set()),
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return `http://127.0.0.1:${address.port}`;
}

const startServer = (): Promise<string> => listen(pool, gateway);

async function closeServers(): Promise<void> {
  const closing = servers.splice(0);
  await Promise.all(
    closing.map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: { content: { type: string; text: string }[] };
  error?: { code: number; message: string; data?: unknown };
}

async function post(baseUrl: string, headers: Headers, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function rpc(baseUrl: string, headers: Headers, name: string, args: unknown): Promise<JsonRpcResponse> {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
  return (await post(baseUrl, headers, body)) as JsonRpcResponse;
}

async function listToolNames(baseUrl: string, headers: Headers): Promise<string[]> {
  return z
    .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
    .parse(await post(baseUrl, headers, { jsonrpc: "2.0", id: 1, method: "tools/list" }))
    .result.tools.map((tool) => tool.name);
}

/** The parsed JSON of a successful tool call's first content part. */
function output(response: JsonRpcResponse): unknown {
  expect(response.error).toBeUndefined();
  const text = response.result?.content[0]?.text;
  if (!text) throw new Error("Missing MCP output");
  return JSON.parse(text) as unknown;
}

const createdId = (response: JsonRpcResponse): string => z.object({ id: z.string().uuid() }).parse(output(response)).id;

function expectInvalid(response: JsonRpcResponse, data: Record<string, unknown>): void {
  expect(response.error?.code).toBe(-32602);
  expect(response.error?.data).toMatchObject(data);
}

async function countApprovals(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM approval_requests`);
  return rows[0]!.n;
}

interface Fixtures {
  database: { id: string };
  property: PropertyRow;
  /** Target of the two REST-only option operations. */
  optionProperty: PropertyRow;
  itemA: ItemRow;
  itemB: ItemRow;
  view: ViewRow;
  /**
   * Every further `view`/`view_items` write in a case must reuse it: a mismatched actor either
   * fails ownership or (for a `user` write) silently adopts the view away from its agent creator.
   */
  viewActor: { type: "user" } | { type: "ai_agent"; agentProjectItemId: string };
  targetDatabase: { id: string };
  targetItem: ItemRow;
  relationProperty: PropertyRow;
  singleRelationProperty: PropertyRow;
  subpageItemId?: string;
  subpageBlockId?: string;
  pageEtag?: string;
}

/**
 * With `agentProjectItemId` the view is created as that `ai_agent` actor, because
 * `assertViewWritable` rejects an agent's write to a view it did not create, regardless of grants.
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
  const optionProperty = await chokePoint.createProperty({
    databaseId: database.id,
    key: "tags",
    name: "Tags",
    type: "multi_select",
    config: { options: [{ key: "herbs", label: "Herbs" }] },
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
    optionProperty,
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

/** Links `itemA.title` to `itemB.title`. */
async function linkTitle(fx: Fixtures, extra: Partial<Parameters<typeof insertValueLink>[1]> = {}): Promise<void> {
  await withTransaction(pool, (client) =>
    insertValueLink(client, {
      itemId: fx.itemA.id,
      propertyKey: "title",
      ruleKey: "test",
      sources: [{ kind: "item", sourceItemId: fx.itemB.id, sourcePropertyKey: "title" }],
      ...extra,
    }),
  );
}

async function createSubpage(fx: Fixtures): Promise<void> {
  const created = await createDocStore(pool).createSubpage({ parent: { itemId: fx.itemA.id } }, "user");
  fx.subpageItemId = created.pages[0]?.pageItemId;
  fx.subpageBlockId = created.pages[0]?.blockId;
}

/**
 * The answer is the one for an invented tool name, apart from the repeated name, and the option
 * list is unchanged.
 */
async function expectRefusedAsUnknownTool(
  baseUrl: string,
  headers: Headers,
  body: JsonRpcResponse,
  name: string,
  fx: Fixtures,
): Promise<void> {
  const invented = "semprec.property.option.invented";
  const unknown = await rpc(baseUrl, headers, invented, {});
  expect(body.error).toEqual({ code: -32601, message: `Unknown tool '${name}'` });
  expect(unknown.error).toEqual({ code: -32601, message: `Unknown tool '${invented}'` });
  expect(body.result).toBeUndefined();
  expect((await chokePoint.getProperty(fx.optionProperty.id))?.config).toEqual(fx.optionProperty.config);
}

interface Case {
  /**
   * The arguments of the tool `semprec.<operation>`. MCP has no route layer to resolve a shorthand,
   * unlike REST's `:propertyKey` relation route.
   */
  args: (fx: Fixtures) => unknown;
  /**
   * State the operation itself does not create (archived, deleted, positioned), applied through
   * `chokePoint`, never through the tool under test.
   */
  prepare?: (fx: Fixtures) => Promise<void>;
}

/**
 * One `tools/call` case per catalog operation, run by a human-session actor (never approval-gated)
 * and by a run credential scoped to the operation's own capability (approval-gated for destructive
 * operations). REST-only operations carry valid arguments and are expected to be refused as unknown
 * tools by both.
 */
const CASES: Record<GenericOperationName, Case> = {
  "database.list": { args: () => ({}) },
  "database.get": { args: (fx) => ({ databaseId: fx.database.id }) },
  "database.create": { args: () => ({ name: "MCP Contract Create" }) },
  "database.patch": { args: (fx) => ({ databaseId: fx.database.id, patch: { name: "Renamed" } }) },
  "database.archive": { args: (fx) => ({ databaseId: fx.database.id }) },
  "database.restore": {
    args: (fx) => ({ databaseId: fx.database.id }),
    prepare: async (fx) => {
      await chokePoint.archiveDatabase(fx.database.id);
    },
  },
  "property.list": { args: (fx) => ({ databaseId: fx.database.id }) },
  "property.get": { args: (fx) => ({ propertyId: fx.property.id }) },
  "property.getByKey": {
    args: (fx) => ({ databaseId: fx.database.id, key: fx.relationProperty.key, type: "relation" }),
  },
  "property.create": {
    args: (fx) => ({ databaseId: fx.database.id, key: "score", name: "Score", type: "number" }),
  },
  "property.patch": { args: (fx) => ({ propertyId: fx.property.id, patch: { name: "New Title" } }) },
  "property.delete": { args: (fx) => ({ propertyId: fx.property.id }) },
  "property.option.add": { args: (fx) => ({ propertyId: fx.optionProperty.id, label: "Spices" }) },
  "property.option.update": {
    args: (fx) => ({ propertyId: fx.optionProperty.id, key: "herbs", label: "Fresh herbs" }),
  },
  "view.list": { args: () => ({}) },
  "view.get": { args: (fx) => ({ viewId: fx.view.id }) },
  "view.create": { args: (fx) => ({ databaseId: fx.database.id, type: "table", name: "All rows" }) },
  "view.patch": { args: (fx) => ({ viewId: fx.view.id, patch: { name: "Renamed view" } }) },
  "view.delete": { args: (fx) => ({ viewId: fx.view.id }) },
  "view.query": { args: (fx) => ({ viewId: fx.view.id }) },
  "viewItem.add": { args: (fx) => ({ viewId: fx.view.id, itemId: fx.itemB.id, position: 1 }) },
  "viewItem.remove": { args: (fx) => ({ viewId: fx.view.id, itemId: fx.itemA.id }) },
  "viewItem.reorder": {
    args: (fx) => ({ viewId: fx.view.id, itemId: fx.itemB.id, position: 0 }),
    prepare: async (fx) => {
      await chokePoint.addViewItem({ viewId: fx.view.id, itemId: fx.itemB.id, position: 1, actor: fx.viewActor });
    },
  },
  "item.get": { args: (fx) => ({ itemId: fx.itemA.id }) },
  "item.create": {
    args: (fx) => ({
      databaseId: fx.database.id,
      properties: { title: "Contract Item" },
      relations: [{ propertyKey: fx.relationProperty.key, targetItemIds: [fx.targetItem.id] }],
    }),
  },
  "item.patch": {
    args: (fx) => ({ itemId: fx.itemA.id, properties: { title: "Updated" }, ifVersion: fx.itemA.version }),
  },
  "item.delete": { args: (fx) => ({ itemId: fx.itemB.id }) },
  "item.restore": {
    args: (fx) => ({ itemId: fx.itemB.id }),
    prepare: async (fx) => {
      await chokePoint.softDeleteItem(fx.database.id, fx.itemB.id);
    },
  },
  "database.query": { args: (fx) => ({ databaseId: fx.database.id }) },
  "relation.put": {
    args: (fx) => ({
      relationPropertyId: fx.relationProperty.id,
      callerItemId: fx.itemB.id,
      targetItemId: fx.targetItem.id,
    }),
  },
  "relation.set": {
    args: (fx) => ({
      relationPropertyId: fx.singleRelationProperty.id,
      callerItemId: fx.itemB.id,
      targetItemId: fx.targetItem.id,
    }),
  },
  "relation.delete": {
    args: (fx) => ({
      relationPropertyId: fx.relationProperty.id,
      callerItemId: fx.itemA.id,
      targetItemId: fx.targetItem.id,
    }),
  },
  "relation.list": { args: (fx) => ({ itemId: fx.itemA.id }) },
  "relation.related": { args: (fx) => ({ itemId: fx.itemA.id }) },
  "link.unlink": { args: (fx) => ({ itemId: fx.itemA.id, propertyKey: "title" }), prepare: (fx) => linkTitle(fx) },
  "link.relink": {
    args: (fx) => ({ itemId: fx.itemA.id, propertyKey: "title" }),
    prepare: (fx) => linkTitle(fx, { state: "broken", brokenBy: "user", brokenAt: new Date() }),
  },
  "page.ensure": { args: (fx) => ({ itemId: fx.itemA.id }) },
  "page.ensureJournalPeriod": { args: () => ({ type: "week", date: "2026-10-16" }) },
  // The period has no duplicate, so a human session gets `{ merged: false }` and a run credential
  // is held for approval.
  "page.mergeJournalDuplicates": { args: () => ({ type: "day", period: "2026-10-16" }) },
  "page.insert": { args: (fx) => ({ itemId: fx.itemA.id, placement: "end", markdown: "Contract text" }) },
  // Destructive for a run credential: held for approval with the page's current version token.
  "page.replace": {
    args: (fx) => ({ itemId: fx.itemA.id, markdown: "Contract replacement", expectedEtag: fx.pageEtag }),
    prepare: async (fx) => {
      fx.pageEtag = (await createDocStore(pool).readPageMarkdown(fx.itemA.id)).etag;
    },
  },
  "page.createSubpage": { args: (fx) => ({ parent: { itemId: fx.itemA.id }, title: "Contract subpage" }) },
  "page.duplicate": { args: (fx) => ({ pageItemId: fx.subpageItemId }), prepare: createSubpage },
  "page.rename": { args: (fx) => ({ pageItemId: fx.subpageItemId, title: "Contract title" }), prepare: createSubpage },
  // Destructive for a run credential: held for approval with the current count of pages the block
  // names.
  "page.convertToBlock": {
    args: (fx) => ({ parentItemId: fx.itemA.id, blockId: fx.subpageBlockId, type: "text", confirmedPageCount: 1 }),
    prepare: createSubpage,
  },
  "page.get": { args: (fx) => ({ itemId: fx.itemA.id, format: "summary" }) },
  "page.changes": { args: (fx) => ({ itemId: fx.itemA.id, since: new Date(Date.now() - 60 * 1000).toISOString() }) },
  "page.restoreVersion": {
    // The block's update is dated an hour back, so the instant (half an hour back) sits inside the
    // history `prepare` opens.
    args: (fx) => ({ itemId: fx.itemA.id, at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }),
    prepare: async (fx) => {
      await createDocStore(pool).putBlock(
        fx.itemA.id,
        { id: "b1", flavour: "paragraph", fields: { content: "first" } },
        "user",
      );
      const docOfItem = "doc_id = (SELECT id FROM docs WHERE item_id = $1)";
      for (const sql of [
        `UPDATE docs SET history_available_from = now() - interval '1 hour' WHERE item_id = $1`,
        `UPDATE doc_snapshot_history SET represented_at = now() - interval '1 hour' WHERE through_update_id = 0 AND ${docOfItem}`,
        `UPDATE doc_updates SET created_at = now() - interval '1 hour' WHERE ${docOfItem}`,
        `UPDATE doc_history_updates SET created_at = now() - interval '1 hour' WHERE ${docOfItem}`,
      ]) {
        await pool.query(sql, [fx.itemA.id]);
      }
    },
  },
  "item.count": { args: (fx) => ({ items: [{ databaseId: fx.database.id }] }) },
  "database.facets": { args: (fx) => ({ databaseId: fx.database.id, facets: [fx.relationProperty.key] }) },
  search: { args: () => ({ q: "contract", scope: ["task", "event"] }) },
};

interface RuntimeHarness {
  runtime: Pool;
  cp: ChokePoint;
  ownTenant: string;
  foreignTenant: string;
  /** Mints an own-tenant `core.item.write` run credential and serves MCP over the runtime role. */
  connect: () => Promise<(name: string, args: unknown) => Promise<JsonRpcResponse>>;
  snapshot: (tenantId: string) => Promise<unknown>;
  targets: (tenantId: string, itemId: string, propertyId: string) => Promise<string[] | undefined>;
}

/** Runs `test` against MCP served over a non-bypassing runtime role, with two tenants. */
async function withRuntimeMcp(test: (harness: RuntimeHarness) => Promise<void>): Promise<void> {
  const runtime = await createRuntimeRolePool(pool, "semprec_data");
  let failure: { error: unknown } | undefined;
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
    const connect = async () => {
      const credential = await runInTenant(ownTenant, async () => {
        const projects = await moduleDatabase("projects", runtime);
        const project = await cp.createItem({ databaseId: projects.id, properties: { name: "MCP runtime agent" } });
        return withTransaction(runtime, (client) =>
          mintMcpRunCredential(client, {
            projectItemId: project.id,
            capabilities: ["core.item.write"],
            userId: user.id,
          }),
        );
      });
      const baseUrl = await listen(runtime, createGenericOperationGateway(runtime, testMetadataResolver));
      const headers = { Authorization: `Bearer ${credential.token}` };
      return (name: string, args: unknown) => rpc(baseUrl, headers, name, args);
    };
    const snapshot = (tenantId: string) =>
      runInTenant(tenantId, async () => {
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
    const targets = (tenantId: string, itemId: string, propertyId: string) =>
      runInTenant(tenantId, async () =>
        (await cp.listItemRelations(itemId, propertyId))?.map((edge) => edge.targetItemId),
      );
    await test({ runtime, cp, ownTenant, foreignTenant, connect, snapshot, targets });
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const step of [closeServers, () => runtime.end()]) {
    try {
      await step();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failure) {
    if (cleanupErrors.length > 0) console.error("MCP runtime fixture cleanup also failed", cleanupErrors);
    throw failure.error;
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "MCP runtime fixture cleanup failed");
}

describe("generic operation MCP contract", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    gateway = createGenericOperationGateway(pool, testMetadataResolver);
    servers = [];
  });

  afterEach(async () => {
    await closeServers();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("sanitizes Emails.body on MCP item.get", async () => {
    const raw = '<p onclick="evil()">safe</p><script>evil()</script><img src="https://tracker.example/pixel">';
    const emails = await moduleDatabase("emails");
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: emails.id, properties: { body: raw } },
        { allowedSystemKeys: ["body"] },
      ),
    );
    const body = await rpc(await startServer(), await authHeader(), "semprec.item.get", { itemId: item.id });
    expect(body.error).toBeUndefined();
    const text = body.result?.content.map((part) => part.text).join("");
    expect(text).toContain("safe");
    expect(text).not.toMatch(/<script|onclick|https:\/\/tracker/i);
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
    const result = await rpc(await startServer(), await authHeader(), "semprec.page.get", {
      itemId: fx.itemA.id,
      format: "summary",
    });
    expect(result.error).toMatchObject({ code: -32000, data: { code: "version_conflict" } });
    expect((await state()).rows).toEqual(before.rows);
  });

  it("ensures and reads the same page through a human MCP session", async () => {
    const fx = await buildFixtures();
    const baseUrl = await startServer();
    const headers = await authHeader();
    const ensure = async () => output(await rpc(baseUrl, headers, "semprec.page.ensure", { itemId: fx.itemA.id }));
    const first = z.object({ docId: z.string() }).parse(await ensure());
    expect(await ensure()).toEqual(first);
    expect(
      output(await rpc(baseUrl, headers, "semprec.page.get", { itemId: fx.itemA.id, format: "summary" })),
    ).toMatchObject(first);
    expect((await pool.query("SELECT id FROM docs WHERE item_id = $1", [fx.itemA.id])).rows).toHaveLength(1);
  });

  it("writes a summary into the Journal week of a date through a run credential: page.ensureJournalPeriod is listed, then page.insert is authored ai_agent", async () => {
    const baseUrl = await startServer();
    const headers = await credentialHeader(await createProjectItem(), ["core.item.write"]);
    expect(await listToolNames(baseUrl, headers)).toContain("semprec.page.ensureJournalPeriod");

    const ensured = await rpc(baseUrl, headers, "semprec.page.ensureJournalPeriod", {
      type: "week",
      date: "2026-10-16",
    });
    const week = z.object({ itemId: z.string(), period: z.literal("2026-W42") }).parse(output(ensured));
    const inserted = await rpc(baseUrl, headers, "semprec.page.insert", {
      itemId: week.itemId,
      placement: "end",
      markdown: "Sprint summary",
    });
    expect(inserted.error).toBeUndefined();
    const authors = await pool.query<{ created_by: string }>(
      `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
      [week.itemId],
    );
    expect(authors.rows.map((row) => row.created_by)).toEqual(["ai_agent"]);
    expect(await countApprovals()).toBe(0);
  });

  it("holds semprec.page.mergeJournalDuplicates for a day with two live entries for approval through a run credential, under the catalog operation name, and merges nothing", async () => {
    const baseUrl = await startServer();
    const journal = await moduleDatabase("journal");
    // Lazy creation never produces two live entries of one period, so the fixture creates them
    // directly.
    const entries: string[] = [];
    for (let n = 0; n < 2; n += 1) {
      const created = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: journal.id, properties: { name: "\u{1F4D3} 2037-05-02", type: "day", period: "2037-05-02" } },
          { allowedSystemKeys: ["name", "type", "period"] },
        ),
      );
      entries.push(created.id);
    }
    const headers = await credentialHeader(await createProjectItem(), ["core.item.write"]);
    const merge = (period: string) =>
      rpc(baseUrl, headers, "semprec.page.mergeJournalDuplicates", { type: "day", period });

    expect((await merge("2037-05-02")).error?.code).toBe(-32001);
    const requests = await pool.query<{ tool_name: string; status: string; payload: { operationName?: string } }>(
      `SELECT tool_name, status, payload FROM approval_requests`,
    );
    // The request names the catalog operation, the name the AgentTool adapter queues it under.
    expect(requests.rows).toEqual([
      {
        tool_name: "page.mergeJournalDuplicates",
        status: "pending",
        payload: expect.objectContaining({ operationName: "page.mergeJournalDuplicates" }),
      },
    ]);
    const live = await pool.query<{ id: string }>(
      `SELECT id FROM items WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [entries],
    );
    expect(live.rows.map((row) => row.id).sort()).toEqual([...entries].sort());
    expectInvalid(await merge("2026-02-30"), { field: "period" });
  });

  it("creates a subpage under a Journal day that has no entry yet, in one call", async () => {
    const body = await rpc(await startServer(), await authHeader(), "semprec.page.createSubpage", {
      parent: { journal: { type: "day", period: "2026-10-16" } },
      title: "Day plan",
    });
    z.object({ pages: z.array(z.object({ pageItemId: z.string(), blockId: z.string() })).length(1) }).parse(
      output(body),
    );
    const dayPage = await pool.query<{ item_id: string }>(
      `SELECT doc.item_id FROM items i JOIN databases d ON d.id = i.database_id JOIN docs doc ON doc.item_id = i.id
       WHERE d.owner_module_id = 'journal' AND i.properties->>'period' = '2026-10-16' AND doc.kind = 'page'`,
    );
    expect(dayPage.rows).toHaveLength(1);
  });

  it("validates Areas create and patch through MCP", async () => {
    const database = await moduleDatabase("areas");
    const item = await chokePoint.createItem({ databaseId: database.id, properties: { name: "Area" } });
    const baseUrl = await startServer();
    const headers = await authHeader();
    const patch = (properties: Record<string, unknown>) =>
      rpc(baseUrl, headers, "semprec.item.patch", { itemId: item.id, properties, ifVersion: item.version });
    for (const [field, value] of [
      ["icon", "rocket123"],
      ["color", "#123456"],
    ] as const) {
      const created = await rpc(baseUrl, headers, "semprec.item.create", {
        databaseId: database.id,
        properties: { name: "Invalid", [field]: value },
      });
      expect(created.error).toMatchObject({ code: -32602, data: { field } });
      expect((await patch({ [field]: value })).error).toMatchObject({ code: -32602, data: { field } });
    }
    expect((await patch({ icon: "briefcase", color: "#5856D6" })).error).toBeUndefined();
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
    const result = await rpc(await startServer(), await authHeader(), "semprec.link.unlink", {
      itemId: file.id,
      propertyKey: "projects",
    });
    expect(output(result)).toMatchObject({
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
    const areas = await moduleDatabase("areas");
    const system = (await chokePoint.listItems(areas.id)).items.find((item) => item.properties.systemActive === true);
    if (!system) throw new Error("System area missing");
    const user = await chokePoint.createItem({ databaseId: areas.id, properties: { name: "User area" } });
    const baseUrl = await startServer();
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
    expect(output(queried)).toMatchObject({ items: [expect.objectContaining({ id: user.id })] });
    expect(JSON.stringify(output(queried))).not.toContain(system.id);
  });

  /** A patch of a Projects item at its current version. */
  async function projectPatcher(properties: Record<string, unknown>) {
    const { id: databaseId } = await moduleDatabase("projects");
    const item = await chokePoint.createItem({ databaseId, properties: { name: "Project", ...properties } });
    const baseUrl = await startServer();
    const headers = await authHeader();
    const read = async () => {
      const current = await chokePoint.getItem(databaseId, item.id);
      if (!current) throw new Error("Missing project fixture");
      return current;
    };
    const patch = async (patchProperties: Record<string, unknown>) => {
      const args: InputByOperation["item.patch"] = {
        itemId: item.id,
        properties: patchProperties,
        ifVersion: (await read()).version,
      };
      return rpc(baseUrl, headers, "semprec.item.patch", args);
    };
    return { patch, properties: async () => (await read()).properties };
  }

  it("returns project completion in the MCP patch response and refuses direct writes", async () => {
    const project = await projectPatcher({ status: "inProgress" });
    const day = today(await withTransaction(pool, getSystemTimezone));
    expect(output(await project.patch({ status: "done" }))).toMatchObject({
      properties: { status: "done", completedAt: day },
    });
    expect((await project.patch({ completedAt: "2000-01-01" })).error).toBeDefined();
    expect((await project.properties()).completedAt).toBe(day);
  });

  it("keeps and restores project deadlines through MCP", async () => {
    const project = await projectPatcher({ status: "inProgress", date: "2026-11-30" });
    expect((await project.patch({ status: "longTerm" })).error).toBeUndefined();
    expect((await project.properties()).date).toBeNull();
    expectInvalid(await project.patch({ date: "2027-01-01" }), { field: "date" });
    expect((await project.patch({ status: "inProgress" })).error).toBeUndefined();
    expect((await project.properties()).date).toBe("2026-11-30");
  });

  it.each(["done", "archived"])("unpins Projects and refuses explicit terminal pins over MCP (%s)", async (status) => {
    const project = await projectPatcher({ status: "inProgress", pinned: true });
    expect(output(await project.patch({ status }))).toMatchObject({ properties: { status, pinned: false } });
    for (const patch of [{ pinned: true }, { status, pinned: true }]) {
      expectInvalid(await project.patch(patch), { field: "pinned" });
      expect(await project.properties()).toMatchObject({ status, pinned: false });
    }
    for (const activeStatus of ["inProgress", "longTerm"]) {
      expect((await project.patch({ status: activeStatus, pinned: true })).error).toBeUndefined();
      expect(await project.properties()).toMatchObject({ status: activeStatus, pinned: true });
    }
    expectInvalid(await project.patch({ status, pinned: true }), { field: "pinned" });
    expect(await project.properties()).toMatchObject({ status: "longTerm", pinned: true });
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
    const user = await sessionUser();
    const baseUrl = await startServer();
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      const result = await rpc(baseUrl, user.headers, "semprec.relation.delete", CASES["relation.delete"].args(fx));
      expect(result.error).toBeUndefined();
      expect(events.filter((event) => event.scope === "item" && event.itemId === fx.itemA.id)).toEqual([
        expect.objectContaining({ userId: user.id }),
      ]);
    } finally {
      setInvalidationHook(() => {});
    }
  });

  it("has exactly one contract case per operation in the closed catalog", () => {
    expect(Object.keys(CASES).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
  });

  it("lists relation.set and both link operations, and no REST-only operation, for a human session and a run credential holding its capability", async () => {
    const baseUrl = await startServer();
    const human = await listToolNames(baseUrl, await authHeader());
    expect(human).toEqual(
      expect.arrayContaining(["semprec.relation.set", "semprec.link.unlink", "semprec.link.relink"]),
    );
    const agent = await listToolNames(
      baseUrl,
      await credentialHeader(await createProjectItem(), ["core.schema.write"]),
    );
    for (const names of [human, agent]) {
      // So the two are absent for being REST-only, not ungranted.
      expect(names).toContain("semprec.property.patch");
      for (const operation of REST_ONLY_OPERATION_NAMES) expect(names).not.toContain(`semprec.${operation}`);
    }
  });

  it("refuses link operations without item write capability through MCP", async () => {
    const projectItemId = await createProjectItem();
    const fx = await buildFixtures(projectItemId);
    await linkTitle(fx);
    const baseUrl = await startServer();
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
    await withRuntimeMcp(async ({ runtime, cp, ownTenant, foreignTenant, connect, snapshot, targets }) => {
      const fixture = (tenantId: string) =>
        runInTenant(tenantId, async () => {
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
          const targetItem = () => cp.createItem({ databaseId: target.id, properties: {} });
          const first = await targetItem();
          const second = await targetItem();
          const third = await targetItem();
          await cp.setRelation({ relationPropertyId: property.id, callerItemId: caller.id, targetItemId: first.id });
          return { source, target, property, caller, second, third };
        });
      const own = await fixture(ownTenant);
      const foreign = await fixture(foreignTenant);
      const call = await connect();
      const ownTargets = (itemId: string, propertyId = own.property.id) => targets(ownTenant, itemId, propertyId);
      const createLinked = (targetItemId: string, extra: Record<string, unknown> = {}) =>
        call("semprec.item.create", {
          databaseId: own.source.id,
          properties: {},
          relations: [{ propertyKey: "link", targetItemIds: [targetItemId] }],
          ...extra,
        });
      const setLink = (targetItemId: string) =>
        call("semprec.relation.set", {
          relationPropertyId: own.property.id,
          callerItemId: own.caller.id,
          targetItemId,
        });

      const moved = await setLink(own.second.id);
      expect(moved.error).toBeUndefined();
      expect(moved.result?.content).toHaveLength(1);
      expect(await ownTargets(own.caller.id)).toEqual([own.second.id]);
      expect(await ownTargets(createdId(await createLinked(own.third.id)))).toEqual([own.third.id]);

      const fileFixture = await runInTenant(ownTenant, async () => {
        const files = await moduleDatabase("files", runtime);
        const projects = await moduleDatabase("projects", runtime);
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
      expect(await ownTargets(createdId(file), fileFixture.property.id)).toEqual([fileFixture.project.id]);

      const ownBefore = await snapshot(ownTenant);
      const foreignBefore = await snapshot(foreignTenant);
      const expectUnchanged = async () => {
        expect(await snapshot(ownTenant)).toEqual(ownBefore);
        expect(await snapshot(foreignTenant)).toEqual(foreignBefore);
      };
      expectInvalid(await createLinked(own.third.id, { properties: { link: own.third.id } }), { field: "link" });
      await expectUnchanged();
      // A foreign target is refused exactly like a missing one.
      const missing = randomUUID();
      for (const invoke of [setLink, createLinked]) {
        const denied = await invoke(foreign.third.id);
        const absent = await invoke(missing);
        if (!denied.error || !absent.error) throw new Error("Expected MCP refusals");
        expect(JSON.stringify(denied.error).replaceAll(foreign.third.id, "<target>")).toBe(
          JSON.stringify(absent.error).replaceAll(missing, "<target>"),
        );
        await expectUnchanged();
      }

      // An idempotent replay answers the original item even after its relation property is deleted,
      // while a fresh key is refused; neither writes anything nor enqueues a job.
      const replayTarget = await runInTenant(ownTenant, async () => {
        await cp.createProperty({ databaseId: own.source.id, key: "scalar", name: "Scalar", type: "text" });
        return cp.createItem({ databaseId: own.target.id, properties: {} });
      });
      const idempotencyKey = randomUUID();
      const originalId = createdId(await createLinked(replayTarget.id, { idempotencyKey }));
      expect(await ownTargets(originalId)).toEqual([replayTarget.id]);
      await runInTenant(ownTenant, () => cp.deleteProperty(own.property.id));
      expect(await runInTenant(ownTenant, () => cp.listProperties(own.source.id))).not.toContainEqual(
        expect.objectContaining({ id: own.property.id }),
      );
      const state = async () => {
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
        return { own: await snapshot(ownTenant), foreign: await snapshot(foreignTenant), jobs: result.rows, payloads };
      };
      const afterDelete = await state();
      for (const propertyKey of ["link", "scalar"]) {
        const relations = [{ propertyKey, targetItemIds: [replayTarget.id] }];
        expect(createdId(await createLinked(replayTarget.id, { idempotencyKey, relations }))).toBe(originalId);
        expect(await state()).toEqual(afterDelete);
        const fresh = await createLinked(replayTarget.id, { idempotencyKey: randomUUID(), relations });
        expectInvalid(fresh, { field: "relations" });
        expect(await state()).toEqual(afterDelete);
      }
    });
  });

  it("refuses a run credential's generic Journal events writes with owner_violation under tenant RLS", async () => {
    await withRuntimeMcp(async ({ runtime, cp, ownTenant, foreignTenant, connect, snapshot, targets }) => {
      const fixture = (tenantId: string) =>
        runInTenant(tenantId, async () => {
          await seedSystem(runtime, createViewTypeRegistry());
          const journal = await moduleDatabase("journal", runtime);
          const journalProperties = await cp.listProperties(journal.id);
          const events = journalProperties.find((entry) => entry.key === "events");
          const project = journalProperties.find((entry) => entry.key === "project");
          if (!events || !project) throw new Error("Missing Journal relations");
          if (events.ownerProcess === null) throw new Error("Journal.events has no owner process");
          const day = await withTransaction(runtime, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-16"));
          const eventsDb = await moduleDatabase("events", runtime);
          const event = (name: string) =>
            cp.createItem({ databaseId: eventsDb.id, properties: { name, date: "2026-10-16" } });
          const standup = await event("Standup");
          const linked = await event("Retro");
          const projectItem = await cp.createItem({
            databaseId: (await moduleDatabase("projects", runtime)).id,
            properties: { name: "Journal project" },
          });
          // Written as the owning process (the event-link sync) writes it, through the system choke
          // point.
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
      const own = await fixture(ownTenant);
      const foreign = await fixture(foreignTenant);
      const call = await connect();
      const dayTargets = (property: { id: string }) => targets(ownTenant, own.day, property.id);
      expect(await dayTargets(own.events)).toEqual([own.linked.id]);
      const ownBefore = await snapshot(ownTenant);
      const foreignBefore = await snapshot(foreignTenant);

      const invalidations: InvalidationEvent[] = [];
      setInvalidationHook((event) => invalidations.push(event));
      try {
        for (const [name, targetItemId] of [
          ["semprec.relation.put", own.standup.id],
          ["semprec.relation.delete", own.linked.id],
        ] as const) {
          const refused = await call(name, { relationPropertyId: own.events.id, callerItemId: own.day, targetItemId });
          expect(refused.result).toBeUndefined();
          expect(refused.error).toMatchObject({ code: -32000, data: { code: "owner_violation" } });
        }
      } finally {
        setInvalidationHook(() => {});
      }
      expect(invalidations).toEqual([]);
      expect(await snapshot(ownTenant)).toEqual(ownBefore);
      expect(await snapshot(foreignTenant)).toEqual(foreignBefore);

      // So the refusals above are the relation's ownership, not a missing grant or the approval
      // requirement.
      const projectEdge = {
        relationPropertyId: own.project.id,
        callerItemId: own.day,
        targetItemId: own.projectItem.id,
      };
      expect((await call("semprec.relation.put", projectEdge)).error).toBeUndefined();
      expect(await dayTargets(own.project)).toEqual([own.projectItem.id]);
      expect((await call("semprec.relation.delete", projectEdge)).error?.code).toBe(-32001);
      expect(z.object({ approvals: z.array(z.unknown()) }).parse(await snapshot(ownTenant)).approvals).toEqual([
        { id: expect.any(String), status: "pending" },
      ]);
      expect(await dayTargets(own.project)).toEqual([own.projectItem.id]);
      expect(await dayTargets(own.events)).toEqual([own.linked.id]);

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
    });
  });

  it("creates the requested initial relation through MCP", async () => {
    const fx = await buildFixtures();
    const response = await rpc(
      await startServer(),
      await authHeader(),
      "semprec.item.create",
      CASES["item.create"].args(fx),
    );
    const id = createdId(response);
    expect((await chokePoint.getItem(fx.database.id, id))?.properties.title).toBe("Contract Item");
    expect(await chokePoint.listItemRelations(id, fx.relationProperty.id)).toMatchObject([
      { targetItemId: fx.targetItem.id },
    ]);
  });

  it("forbids MCP database creation with properties but permits a bare create", async () => {
    const baseUrl = await startServer();
    const headers = await authHeader();
    const footprint = async () =>
      (
        await pool.query<{ databases: number; properties: number }>(
          "SELECT (SELECT count(*)::int FROM databases) AS databases, (SELECT count(*)::int FROM properties) AS properties",
        )
      ).rows;
    const before = await footprint();
    const rejected = await rpc(baseUrl, headers, "semprec.database.create", {
      name: "MCP with properties",
      properties: [{ key: "note", name: "Note", type: "text" }],
    });
    expect(rejected.error).toMatchObject({ code: -32000, data: { code: "forbidden" } });
    expect(await footprint()).toEqual(before);
    expect((await rpc(baseUrl, headers, "semprec.database.create", { name: "MCP bare" })).error).toBeUndefined();
    expect((await chokePoint.listDatabases()).some((database) => database.name === "MCP bare")).toBe(true);
  });

  it("counts a database with relation groups through MCP item.count and refuses an oversized batch and an ungroupable key", async () => {
    const baseUrl = await startServer();
    const fx = await buildFixtures();
    const headers = await authHeader();
    const count = (items: unknown[]) => rpc(baseUrl, headers, "semprec.item.count", { items });

    // `itemA` is linked to the target item and `itemB` to none.
    expect(
      output(
        await count([
          { databaseId: fx.database.id, groupBy: fx.relationProperty.key },
          { databaseId: fx.targetDatabase.id },
        ]),
      ),
    ).toEqual([
      {
        databaseId: fx.database.id,
        count: 2,
        groups: [
          { key: fx.targetItem.id, count: 1 },
          { key: null, count: 1 },
        ],
      },
      { databaseId: fx.targetDatabase.id, count: 1 },
    ]);
    expectInvalid(await count(Array.from({ length: 21 }, () => ({ databaseId: fx.database.id }))), { field: "items" });
    expectInvalid(await count([{ databaseId: fx.database.id, groupBy: fx.property.key }]), { field: "groupBy" });
  });

  it("lists the collections related to an item through MCP relation.related", async () => {
    const baseUrl = await startServer();
    const fx = await buildFixtures();
    const related = await rpc(baseUrl, await authHeader(), "semprec.relation.related", { itemId: fx.itemA.id });
    // `itemA` is linked to the target item; the target database holds the inverse property.
    expect(output(related)).toEqual([
      {
        databaseKey: null,
        databaseId: fx.targetDatabase.id,
        count: 1,
        via: "direct",
        filter: { type: "relation_contains", property: "assignedFrom", value: fx.itemA.id },
      },
    ]);
  });

  it("reads the facets of a database through MCP database.facets and refuses an oversized list, an own-property condition under or and a key that is no facet", async () => {
    const baseUrl = await startServer();
    const fx = await buildFixtures();
    const headers = await authHeader();
    const titled = (value: string) => ({ type: "equals", property: fx.property.key, value });
    const facets = (args: Record<string, unknown>) =>
      rpc(baseUrl, headers, "semprec.database.facets", { databaseId: fx.database.id, ...args });

    const answered = await facets({
      filter: titled("Dune"),
      facets: [fx.relationProperty.key, fx.property.key],
      extra: { open: titled("Arrival") },
    });
    expect(output(answered)).toEqual([
      // Under the filter only `itemB` counts, which is linked to no target and is not titled "Arrival".
      { property: fx.relationProperty.key, all: 1, open: 0, values: [{ value: null, count: 1 }] },
      // The title facet leaves the title condition out: both items count, `itemA` is the open one.
      {
        property: fx.property.key,
        all: 2,
        open: 1,
        values: [
          { value: "Arrival", count: 1 },
          { value: "Dune", count: 1 },
        ],
      },
    ]);
    expectInvalid(await facets({ facets: Array.from({ length: 21 }, () => fx.property.key) }), { field: "facets" });
    expectInvalid(
      await facets({ filter: { type: "or", nodes: [titled("Dune"), titled("Arrival")] }, facets: [fx.property.key] }),
      { field: "filter" },
    );
    expectInvalid(await facets({ facets: ["missing"] }), { field: "facets" });
  });

  it("searches through MCP search, grouped with the structured subtitle, and refuses an invalid input without repeating the query", async () => {
    const tasks = await moduleDatabase("tasks");
    const task = await chokePoint.createItem({
      databaseId: tasks.id,
      properties: { name: "Odeslat fakturu", date: "2026-10-16", timeFrom: "14:00", timeTo: "15:30" },
    });
    const baseUrl = await startServer();
    const headers = await authHeader();
    const search = (args: Record<string, unknown>) => rpc(baseUrl, headers, "semprec.search", args);

    expect(output(await search({ q: "fakturu" }))).toEqual({
      groups: [
        {
          type: "task",
          total: 1,
          items: [
            {
              itemId: task.id,
              databaseId: tasks.id,
              databaseKey: "tasks",
              title: "Odeslat fakturu",
              subtitleParts: [
                { kind: "date", value: "2026-10-16" },
                { kind: "timeRange", value: "14:00-15:30" },
              ],
              snippet: null,
            },
          ],
          nextCursor: null,
        },
      ],
    });
    const secret = "tajny-dotaz-v-chybe";
    const twoTypesWithCursor = await search({ q: secret, scope: ["task", "event"], cursor: "x" });
    expectInvalid(twoTypesWithCursor, { field: "cursor" });
    expect(JSON.stringify(twoTypesWithCursor.error)).not.toContain(secret);
    expectInvalid(await search({ q: "" }), { field: "q" });
  });

  /**
   * MCP-adapter equivalents of REST parity cases covered in
   * `itemsHandler.test.ts`/`propertiesHandler.test.ts`, and malformed input refused at the MCP
   * boundary. Each leaves the fixture database's definition unchanged.
   */
  it.each<{
    title: string;
    prepare?: (fx: Fixtures) => Promise<unknown>;
    operation: GenericOperationName;
    args: (fx: Fixtures) => unknown;
    error: { code: number; data?: Record<string, unknown> };
  }>([
    {
      title: "surfaces database_archived as -32000 for a write against an archived database",
      prepare: (fx) => chokePoint.archiveDatabase(fx.database.id),
      operation: "item.create",
      args: (fx) => ({ databaseId: fx.database.id, properties: { title: "Arrival" } }),
      error: { code: -32000, data: { code: "database_archived" } },
    },
    {
      // Every input schema is a strict zod object without `AuthenticatedActor`'s field names, so
      // smuggling an identity through `arguments` fails validation instead of being ignored or honored.
      title: "rejects an actor-identity-shaped field smuggled into tool arguments with -32602",
      operation: "view.create",
      args: (fx) => ({
        databaseId: fx.database.id,
        type: "table",
        name: "Stolen view",
        agentProjectItemId: randomUUID(),
        runId: randomUUID(),
        userId: randomUUID(),
      }),
      error: { code: -32602 },
    },
    ...(["type", "config"] as const).map((field) => ({
      title: `rejects patch.${field} on a relation property with relation_definition_required`,
      operation: "property.patch" as const,
      args: (fx: Fixtures) => ({
        propertyId: fx.relationProperty.id,
        patch: field === "type" ? { type: "text" } : { config: { note: "x" } },
      }),
      error: { code: -32602, data: { field, reason: "relation_definition_required" } },
    })),
    {
      // REST resolves `:propertyKey` against the caller item's database and 404s for no match. MCP
      // has no route layer: it takes `relationPropertyId` directly and the choke point rejects an id
      // that names no relation property.
      title: "rejects a non-relation property id supplied directly as relationPropertyId",
      operation: "relation.put",
      args: (fx) => ({ relationPropertyId: fx.property.id, callerItemId: fx.itemA.id, targetItemId: fx.targetItem.id }),
      error: { code: -32602, data: { field: "relationPropertyId" } },
    },
    {
      title: "rejects an empty database patch",
      operation: "database.patch",
      args: (fx) => ({ databaseId: fx.database.id, patch: {} }),
      error: { code: -32602, data: { reason: "empty_patch" } },
    },
    ...(["relation.list", "relation.related", "page.restoreVersion"] as const).map((operation) => ({
      title: `rejects a malformed ${operation} item ID`,
      operation,
      args: () =>
        operation === "page.restoreVersion"
          ? { itemId: "not-a-uuid", at: new Date().toISOString() }
          : { itemId: "not-a-uuid" },
      error: { code: -32602, data: { field: "itemId" } },
    })),
  ])("$title", async ({ prepare, operation, args, error }) => {
    const baseUrl = await startServer();
    const fx = await buildFixtures();
    await prepare?.(fx);
    const databaseBefore = await chokePoint.getDatabase(fx.database.id);
    const body = await rpc(baseUrl, await authHeader(), `semprec.${operation}`, args(fx));
    expect(body.error?.code).toBe(error.code);
    if (error.data) expect(body.error?.data).toMatchObject(error.data);
    expect(await chokePoint.getDatabase(fx.database.id)).toEqual(databaseBefore);
  });

  describe.each([
    { actor: "a plain human-session actor", agent: false },
    { actor: "a run credential scoped to the operation's capability", agent: true },
  ])("catalog dispatch through $actor", ({ agent }) => {
    it.each(
      GENERIC_OPERATION_NAMES.map((operation) => {
        const gated =
          agent && (DESTRUCTIVE_OPERATIONS.includes(operation) || LINK_ENDING_OPERATIONS.includes(operation));
        return { operation, gated, outcome: gated ? "queues an approval request for" : "executes" };
      }),
    )("$outcome $operation", async ({ operation, gated }) => {
      const baseUrl = await startServer();
      const projectItemId = agent ? await createProjectItem() : undefined;
      const fx = await buildFixtures(projectItemId);
      const testCase = CASES[operation];
      await testCase.prepare?.(fx);
      const name = `semprec.${operation}`;
      const headers =
        projectItemId === undefined
          ? await authHeader()
          : await credentialHeader(projectItemId, [OPERATION_METADATA[operation].requiresCapability]);

      const body = await rpc(baseUrl, headers, name, testCase.args(fx));

      if (REST_ONLY_OPERATION_NAMES.some((restOnly) => restOnly === operation)) {
        await expectRefusedAsUnknownTool(baseUrl, headers, body, name, fx);
      } else if (gated) {
        expect(body.error?.code).toBe(-32001);
        expect(await countApprovals()).toBe(1);
      } else {
        expect(body.error).toBeUndefined();
      }
    });
  });
});
