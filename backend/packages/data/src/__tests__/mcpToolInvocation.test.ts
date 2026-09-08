import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { upsertMcpToolRegistration } from "../mcp/mcpToolRegistrationsStore.js";
import { setProjectMcpGrant } from "../mcp/mcpGrantsAdminStore.js";
import { resolveGrantedMcpTool } from "../mcp/mcpToolInvocation.js";

let pool: Pool;
let mcpServersId: string;

async function createMcpServerItem(active: boolean, connectionConfig: unknown = { transport: "stdio", command: "x" }) {
  return withTransaction(pool, (client) =>
    itemsStore.insertItem(client, {
      databaseId: mcpServersId,
      properties: { name: "Server", active, connectionConfig },
    }),
  );
}

describe("resolveGrantedMcpTool (issue #128)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    const database = await withTransaction(pool, (client) =>
      databasesStore.getDatabaseByModuleId(client, "mcpServers"),
    );
    if (!database) throw new Error("mcpServers database was not seeded");
    mcpServersId = database.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("resolves a granted, active tool with its server item's properties", async () => {
    const server = await createMcpServerItem(true, { transport: "stdio", command: "echo" });
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "search_web",
      toolSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      description: "Search the web",
    });
    const projectItemId = randomUUID();
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: true });

    const target = await withTransaction(pool, (client) =>
      resolveGrantedMcpTool(client, projectItemId, registration.id),
    );

    expect(target).toEqual({
      mcpToolRegistrationId: registration.id,
      mcpServerItemId: server.id,
      toolName: "search_web",
      toolSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      requiresApproval: true,
      riskClass: "unclassified",
      serverItem: { id: server.id, properties: { name: "Server", active: true, connectionConfig: { transport: "stdio", command: "echo" } } },
    });
  });

  it("returns null for an unknown registration id", async () => {
    const projectItemId = randomUUID();
    expect(await withTransaction(pool, (client) => resolveGrantedMcpTool(client, projectItemId, randomUUID()))).toBeNull();
  });

  it("returns null when the tool was never granted to this project", async () => {
    const server = await createMcpServerItem(true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "search_web",
      toolSchema: {},
    });
    const projectItemId = randomUUID();

    expect(
      await withTransaction(pool, (client) => resolveGrantedMcpTool(client, projectItemId, registration.id)),
    ).toBeNull();
  });

  it("returns null when the grant was revoked", async () => {
    const server = await createMcpServerItem(true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "search_web",
      toolSchema: {},
    });
    const projectItemId = randomUUID();
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: true });
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: false });

    expect(
      await withTransaction(pool, (client) => resolveGrantedMcpTool(client, projectItemId, registration.id)),
    ).toBeNull();
  });

  it("returns null when the registration is inactive", async () => {
    const server = await createMcpServerItem(true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "search_web",
      toolSchema: {},
      active: false,
    });
    const projectItemId = randomUUID();
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: true });

    expect(
      await withTransaction(pool, (client) => resolveGrantedMcpTool(client, projectItemId, registration.id)),
    ).toBeNull();
  });

  it("returns null when the server is inactive", async () => {
    const server = await createMcpServerItem(false);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "search_web",
      toolSchema: {},
    });
    const projectItemId = randomUUID();
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: true });

    expect(
      await withTransaction(pool, (client) => resolveGrantedMcpTool(client, projectItemId, registration.id)),
    ).toBeNull();
  });

  it("does not let a different project's id reach a grant it doesn't hold (spoofed project identity)", async () => {
    const server = await createMcpServerItem(true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "search_web",
      toolSchema: {},
    });
    const grantedProjectItemId = randomUUID();
    const spoofedProjectItemId = randomUUID();
    await setProjectMcpGrant(pool, {
      projectItemId: grantedProjectItemId,
      mcpToolRegistrationId: registration.id,
      granted: true,
    });

    expect(
      await withTransaction(pool, (client) => resolveGrantedMcpTool(client, spoofedProjectItemId, registration.id)),
    ).toBeNull();
  });
});
