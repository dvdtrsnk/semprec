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
import { setMcpToolRequiresApproval, setMcpToolRiskClass, setProjectMcpGrant } from "../mcp/mcpGrantsAdminStore.js";
import { getGrantedMcpAgentTools } from "../mcp/mcpAgentTools.js";

let pool: Pool;
let mcpServersId: string;

async function createMcpServerItem(active: boolean) {
  return withTransaction(pool, (client) =>
    itemsStore.insertItem(client, { databaseId: mcpServersId, properties: { name: "Server", active } }),
  );
}

describe("getGrantedMcpAgentTools (issue #126)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    const database = await withTransaction(pool, (client) => databasesStore.getDatabaseByModuleId(client, "mcpServers"));
    if (!database) throw new Error("mcpServers database was not seeded");
    mcpServersId = database.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("includes exactly a granted tool on an active server with an active registration", async () => {
    const server = await createMcpServerItem(true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "search_web",
      toolSchema: { type: "object" },
      description: "Search the web",
    });
    const projectItemId = randomUUID();
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: true });

    const tools = await withTransaction(pool, (client) => getGrantedMcpAgentTools(client, projectItemId));
    expect(tools).toEqual([
      {
        source: "mcp",
        mcpServerItemId: server.id,
        mcpToolRegistrationId: registration.id,
        name: "search_web",
        description: "Search the web",
        schema: { type: "object" },
        requiresApproval: true,
        riskClass: "unclassified",
      },
    ]);
  });

  it("excludes an ungranted tool", async () => {
    const server = await createMcpServerItem(true);
    const registration = await upsertMcpToolRegistration(pool, { mcpServerItemId: server.id, toolName: "search_web", toolSchema: {} });
    const projectItemId = randomUUID();
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: false });

    expect(await withTransaction(pool, (client) => getGrantedMcpAgentTools(client, projectItemId))).toEqual([]);
  });

  it("excludes a granted tool whose registration is inactive", async () => {
    const server = await createMcpServerItem(true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "search_web",
      toolSchema: {},
      active: false,
    });
    const projectItemId = randomUUID();
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: true });

    expect(await withTransaction(pool, (client) => getGrantedMcpAgentTools(client, projectItemId))).toEqual([]);
  });

  it("excludes a granted, active-registration tool whose server is inactive", async () => {
    const server = await createMcpServerItem(false);
    const registration = await upsertMcpToolRegistration(pool, { mcpServerItemId: server.id, toolName: "search_web", toolSchema: {} });
    const projectItemId = randomUUID();
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: true });

    expect(await withTransaction(pool, (client) => getGrantedMcpAgentTools(client, projectItemId))).toEqual([]);
  });

  it("preserves a human-set requiresApproval/riskClass on the granted projection", async () => {
    const server = await createMcpServerItem(true);
    const registration = await upsertMcpToolRegistration(pool, { mcpServerItemId: server.id, toolName: "delete_repo", toolSchema: {} });
    await setMcpToolRiskClass(pool, registration.id, "destructive");
    await setMcpToolRequiresApproval(pool, registration.id, true);
    const projectItemId = randomUUID();
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: true });

    const tools = await withTransaction(pool, (client) => getGrantedMcpAgentTools(client, projectItemId));
    expect(tools).toHaveLength(1);
    expect(tools[0].riskClass).toBe("destructive");
    expect(tools[0].requiresApproval).toBe(true);
  });

  it("lets two projects expose different subsets of the same server", async () => {
    const server = await createMcpServerItem(true);
    const toolA = await upsertMcpToolRegistration(pool, { mcpServerItemId: server.id, toolName: "tool_a", toolSchema: {} });
    const toolB = await upsertMcpToolRegistration(pool, { mcpServerItemId: server.id, toolName: "tool_b", toolSchema: {} });
    const projectOne = randomUUID();
    const projectTwo = randomUUID();
    await setProjectMcpGrant(pool, { projectItemId: projectOne, mcpToolRegistrationId: toolA.id, granted: true });
    await setProjectMcpGrant(pool, { projectItemId: projectTwo, mcpToolRegistrationId: toolB.id, granted: true });

    const projectOneTools = await withTransaction(pool, (client) => getGrantedMcpAgentTools(client, projectOne));
    const projectTwoTools = await withTransaction(pool, (client) => getGrantedMcpAgentTools(client, projectTwo));
    expect(projectOneTools.map((t) => t.name)).toEqual(["tool_a"]);
    expect(projectTwoTools.map((t) => t.name)).toEqual(["tool_b"]);
  });
});
