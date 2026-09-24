import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  login,
  mintMcpRunCredential,
  seedSystem,
  type ChokePoint,
  type ItemRow,
  type PropertyRow,
  type ViewRow,
} from "@semprec/data";
import { createGenericOperationGateway, type GenericOperationGateway } from "@semprec/application";
import {
  CAPABILITY_IDS,
  GENERIC_OPERATION_NAMES,
  OPERATION_METADATA,
  type CapabilityId,
  type GenericOperationName,
} from "@semprec/shared";
import { createMcpRequestListener } from "../mcpHandler.js";

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
  const user = await createUser(pool, { email, passwordHash: await hashPassword(PASSWORD) });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

/** Mirrors `mcpHandler.test.ts`'s own `credentialHeader` — a restricted, single-run credential narrowed to exactly `capabilities`. */
async function credentialHeader(
  projectItemId: string,
  capabilities: CapabilityId[],
): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
  });
  const minted = await mintMcpRunCredential(pool, { projectItemId, capabilities, userId: user.id });
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
  const server = createServer(createMcpRequestListener(pool, gateway, ALL_CAPABILITIES));
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
  await chokePoint.createRelation({
    relationPropertyId: relationProperty.id,
    callerItemId: itemA.id,
    targetItemId: targetItem.id,
  });

  return { database, property, itemA, itemB, view, viewActor, targetDatabase, targetItem, relationProperty };
}

interface Case {
  /** The exact `tools/call` name/arguments a real MCP caller would send — MCP has no route layer to resolve a shorthand on its own, unlike REST's `:propertyKey` relation route. */
  tool: (fx: Fixtures) => { name: string; arguments: unknown };
  /** State a case needs already in place before its own operation runs — `restore`/`reorder` targets a row whose prior state (archived, deleted, already-positioned) the operation itself is not what creates. Applied directly through `chokePoint`, never through the tool under test. */
  prepare?: (fx: Fixtures) => Promise<void>;
}

/**
 * One `tools/call` case per operation in the closed 29-operation catalog, mirroring
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
      arguments: { databaseId: fx.database.id, properties: { title: "Contract Item" } },
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
};

describe("generic operation MCP contract (issue #220)", () => {
  let servers: Server[] = [];

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    gateway = createGenericOperationGateway(pool);
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("has exactly one contract case per operation in the closed catalog", () => {
    expect(Object.keys(CASES).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
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
