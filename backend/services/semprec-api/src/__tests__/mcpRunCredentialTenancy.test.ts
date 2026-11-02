import type { CollectionMetadataResolver } from "@semprec/data";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  hashPassword,
  insertValueLink,
  login,
  mintMcpRunCredential,
  setInvalidationHook,
  type InvalidationEvent,
  withTransaction,
} from "@semprec/data";
import { createGenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS } from "@semprec/shared";
import { createAgentRunRequestListener } from "../agentRunHandler.js";
import { createMcpRequestListener } from "../mcp/mcpHandler.js";
import { z } from "zod";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({ icon: null, color: null, overviewOrder: null, switcherOrder: null, clientVisible: true }),
};

const PASSWORD = "s3cret-password";

let adminPool: Pool;
let pool: Pool;
let tenantA: string;
let tenantB: string;
let servers: Server[];

async function listen(listener: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return `http://127.0.0.1:${address.port}`;
}

describe("MCP run credentials across two tenants (issue #994)", () => {
  let agentRunUrl: string;
  let mcpUrl: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    servers = [];
    await resetDatabase(adminPool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    agentRunUrl = await listen(createAgentRunRequestListener(pool));
    mcpUrl = await listen(
      createMcpRequestListener(
        pool,
        createGenericOperationGateway(pool, testMetadataResolver),
        new Set(CAPABILITY_IDS),
      ),
    );
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function createUserIn(tenantId: string): Promise<{ id: string; sessionHeader: { Authorization: string } }> {
    const email = `${randomUUID()}@example.com`;
    const user = await createUser(adminPool, { email, passwordHash: await hashPassword(PASSWORD), tenantId });
    const { token } = await login(adminPool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    return { id: user.id, sessionHeader: { Authorization: `Bearer ${token}` } };
  }

  async function mintCredentialIn(tenantId: string, userId: string): Promise<{ token: string; projectItemId: string }> {
    const projectItemId = await runInTenant(tenantId, () => createTestProjectItem(pool));
    const minted = await runInTenant(tenantId, () =>
      withTransaction(pool, (client) =>
        mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read", "core.database.read"], userId }),
      ),
    );
    return { token: minted.token, projectItemId };
  }

  async function callTool(token: string, name: string, args: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return { status: res.status, body: await res.json() };
  }

  it("answers tenant B's mint with tenant A's Projects item exactly like a random id", async () => {
    const aUser = await createUserIn(tenantA);
    const bUser = await createUserIn(tenantB);
    const aProject = await runInTenant(tenantA, () => createTestProjectItem(pool));
    await runInTenant(tenantB, () => createTestProjectItem(pool));
    const mint = async (projectItemId: string): Promise<{ status: number; text: string }> => {
      const res = await fetch(`${agentRunUrl}/api/agent-runs/mcp-credentials`, {
        method: "POST",
        headers: { ...bUser.sessionHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ projectItemId, capabilities: ["core.item.read"] }),
      });
      return { status: res.status, text: await res.text() };
    };

    const foreign = await mint(aProject);
    const random = await mint(randomUUID());

    expect(foreign).toEqual(random);
    expect(foreign.status).toBe(404);
    const { rows } = await adminPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM agent_runs`);
    expect(rows[0]!.count).toBe("0");
    expect(aUser.id).not.toBe(bUser.id);
  });

  it("serves a credential only inside its own tenant: item.get on a foreign id equals an unknown id, database.query never leaks", async () => {
    const aUser = await createUserIn(tenantA);
    const bUser = await createUserIn(tenantB);
    const a = await mintCredentialIn(tenantA, aUser.id);
    const b = await mintCredentialIn(tenantB, bUser.id);

    const foreignGet = await callTool(a.token, "semprec.item.get", { itemId: b.projectItemId });
    const unknownGet = await callTool(a.token, "semprec.item.get", { itemId: randomUUID() });
    expect(foreignGet).toEqual(unknownGet);

    const databaseId = await runInTenant(tenantA, async () => {
      const { rows } = await withTransaction(pool, (client) =>
        client.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'projects'`),
      );
      return rows[0]!.id;
    });
    const list = await callTool(a.token, "semprec.database.query", { databaseId });
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.body);
    expect(text).toContain(a.projectItemId);
    expect(text).not.toContain(b.projectItemId);
  });

  it("resolves each tenant's credential into its own tenant", async () => {
    const aUser = await createUserIn(tenantA);
    const bUser = await createUserIn(tenantB);
    const a = await mintCredentialIn(tenantA, aUser.id);
    const b = await mintCredentialIn(tenantB, bUser.id);

    const ownA = await callTool(a.token, "semprec.item.get", { itemId: a.projectItemId });
    const ownB = await callTool(b.token, "semprec.item.get", { itemId: b.projectItemId });

    expect(JSON.stringify(ownA.body)).toContain(a.projectItemId);
    expect(JSON.stringify(ownB.body)).toContain(b.projectItemId);
  });

  it("attributes a linked relation write to the minted run's user", async () => {
    const user = await createUserIn(tenantA);
    const projectItemId = await runInTenant(tenantA, () => createTestProjectItem(pool));
    const credential = await runInTenant(tenantA, () =>
      withTransaction(pool, (client) =>
        mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.write"], userId: user.id }),
      ),
    );
    const cp = createChokePoint(pool);
    const fixture = await runInTenant(tenantA, async () => {
      const db = await cp.createDatabase({ name: "MCP linked relations" });
      const { property } = await cp.createRelationProperty({
        sourceDatabaseId: db.id,
        targetDatabaseId: db.id,
        key: "related",
        name: "Related",
        cardinality: "many_to_many",
      });
      const source = await cp.createItem({ databaseId: db.id, properties: {} });
      const target = await cp.createItem({ databaseId: db.id, properties: {} });
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: source.id,
          propertyKey: property.key,
          ruleKey: "test",
          sources: [],
        }),
      );
      return { source, target, property };
    });
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      const result = await callTool(credential.token, "semprec.relation.put", {
        relationPropertyId: fixture.property.id,
        callerItemId: fixture.source.id,
        targetItemId: fixture.target.id,
      });
      expect(result.status).toBe(200);
      expect(result.body).not.toHaveProperty("error");
      expect(events.filter((event) => event.scope === "item" && event.itemId === fixture.source.id)).toEqual([
        expect.objectContaining({ userId: user.id }),
      ]);
    } finally {
      setInvalidationHook(() => {});
    }
  });

  it("breaks a linked value through a minted agent-run MCP credential within its tenant", async () => {
    const user = await createUserIn(tenantA);
    const projectItemId = await runInTenant(tenantA, () => createTestProjectItem(pool));
    const credential = await runInTenant(tenantA, () =>
      withTransaction(pool, (client) =>
        mintMcpRunCredential(client, {
          projectItemId,
          capabilities: ["core.item.write", "core.item.read"],
          userId: user.id,
        }),
      ),
    );
    const cp = createChokePoint(pool);
    const makeLinkedItem = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        const db = await cp.createDatabase({ name: "Linked" });
        await cp.createProperty({ databaseId: db.id, key: "note", name: "Note", type: "text" });
        const item = await cp.createItem({ databaseId: db.id, properties: { note: "before" } });
        await withTransaction(pool, (client) =>
          insertValueLink(client, {
            itemId: item.id,
            propertyKey: "note",
            ruleKey: "test",
            sources: [],
          }),
        );
        return item;
      });
    const own = await makeLinkedItem(tenantA);
    const foreign = await makeLinkedItem(tenantB);
    const patchOther = (itemId: string) =>
      callTool(credential.token, "semprec.item.patch", {
        itemId,
        properties: { note: "forbidden" },
        ifVersion: foreign.updatedAt,
      });
    const foreignAttempt = await patchOther(foreign.id);
    const missingAttempt = await patchOther(randomUUID());
    expect(foreignAttempt).toEqual(missingAttempt);
    expect(foreignAttempt.body).toMatchObject({ error: { code: -32601 } });
    const patched = await callTool(credential.token, "semprec.item.patch", {
      itemId: own.id,
      properties: { note: "after" },
      ifVersion: own.updatedAt,
    });
    expect(patched.status).toBe(200);
    expect(patched.body).not.toHaveProperty("error");
    const read = await callTool(credential.token, "semprec.item.get", { itemId: own.id, include: ["links"] });
    const envelope = z
      .object({ result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) }) })
      .parse(read.body);
    const text = envelope.result.content.find((part) => part.type === "text")?.text;
    if (text === undefined) throw new Error("Missing MCP result content");
    const result: unknown = JSON.parse(text);
    expect(result).toMatchObject({
      properties: { note: "after" },
      links: { note: { valueKind: "inheritedBroken", brokenBy: "agent" } },
    });
    const foreignLinks = await runInTenant(tenantB, () => cp.getValueLinksForItems([foreign.id]));
    expect(foreignLinks.get(foreign.id)?.note).toMatchObject({ valueKind: "inherited", brokenBy: null });
    expect((await runInTenant(tenantB, () => cp.getItem(foreign.databaseId, foreign.id)))?.properties.note).toBe(
      "before",
    );
  });
});
