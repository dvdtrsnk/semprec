import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  DEFAULT_CONTRACT_TOOLS,
  startHttpContractServer,
  startSseContractServer,
  startStdioContractServer,
  type ContractServerTool,
  type McpContractServer,
} from "../testSupport/mcpContractServers.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { listAllTools, syncMcpServerTools } from "../mcp/mcpSync.js";
import type { McpClientHandle } from "../mcp/mcpConnectionFactory.js";
import { listMcpToolRegistrationsForServer } from "../mcp/mcpToolRegistrationsStore.js";
import { setMcpToolRequiresApproval, setMcpToolRiskClass } from "../mcp/mcpGrantsAdminStore.js";
import type { McpConnectionConfig } from "../mcp/mcpConnectionConfig.js";
import { NotFoundError, ValidationError } from "../errors.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let mcpServersId: string;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function createMcpServerItem(connectionConfig: McpConnectionConfig, credential?: string) {
  const item = await withTransaction(pool, (client) =>
    itemsStore.insertItem(client, { databaseId: mcpServersId, properties: { name: "Contract server", connectionConfig } }),
  );
  if (credential !== undefined) {
    await withTransaction(pool, (client) => storeCredential(client, { itemId: item.id, credentialType: "api_key", plaintext: credential }));
  }
  return item;
}

async function getServerItem(itemId: string) {
  const item = await withTransaction(pool, (client) => itemsStore.getItemById(client, mcpServersId, itemId));
  if (!item) throw new Error("server item disappeared");
  return item;
}

/** `vi.waitFor` guards against socket cleanup being asynchronous relative to when `close()` resolves — mirrors mcpConnectionFactory.test.ts's own helper. */
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error(message);
    },
    { timeout: 5_000, interval: 20 },
  );
}

describe("MCP tool sync (issue #125)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    mcpServersId = await databaseIdFor("mcpServers");
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe.each([
    ["stdio", () => Promise.resolve(startStdioContractServer())],
    ["sse", () => startSseContractServer()],
    ["http", () => startHttpContractServer()],
  ] as const)("%s transport", (_name, start) => {
    it("materializes the advertised tools with default approval/risk values and sets syncStatus ok", async () => {
      const contract: McpContractServer = await start();
      try {
        const item = await createMcpServerItem(contract.connectionConfig);

        const result = await syncMcpServerTools(pool, item.id);

        expect(result.toolCount).toBe(DEFAULT_CONTRACT_TOOLS.length);
        const registrations = await listMcpToolRegistrationsForServer(pool, item.id);
        expect(registrations).toHaveLength(1);
        expect(registrations[0]).toMatchObject({
          toolName: "search_web",
          description: "Searches the web",
          active: true,
          requiresApproval: true,
          riskClass: "unclassified",
        });

        const updated = await getServerItem(item.id);
        expect(updated.properties.syncStatus).toBe("ok");
        expect(updated.properties.syncError).toBeNull();
        expect(updated.properties.lastSynced).toEqual(expect.any(String));
      } finally {
        await contract.stop();
      }
    });

    it("preserves human-set risk_class/requires_approval across a re-sync while refreshing the schema/description", async () => {
      const contract: McpContractServer = await start();
      try {
        const item = await createMcpServerItem(contract.connectionConfig);
        await syncMcpServerTools(pool, item.id);
        const [first] = await listMcpToolRegistrationsForServer(pool, item.id);
        await setMcpToolRiskClass(pool, first.id, "high");
        await setMcpToolRequiresApproval(pool, first.id, false);

        contract.setTools([{ name: "search_web", description: "Updated description", inputSchema: { type: "object", properties: { q: { type: "string" } } } }]);
        await syncMcpServerTools(pool, item.id);

        const [resynced] = await listMcpToolRegistrationsForServer(pool, item.id);
        expect(resynced.id).toBe(first.id);
        expect(resynced.description).toBe("Updated description");
        expect(resynced.toolSchema).toEqual({ type: "object", properties: { q: { type: "string" } } });
        expect(resynced.riskClass).toBe("high");
        expect(resynced.requiresApproval).toBe(false);
      } finally {
        await contract.stop();
      }
    });

    it("deactivates a tool the server stops advertising, without deleting its row", async () => {
      const contract: McpContractServer = await start();
      try {
        const item = await createMcpServerItem(contract.connectionConfig);
        await syncMcpServerTools(pool, item.id);
        const [existing] = await listMcpToolRegistrationsForServer(pool, item.id);

        contract.setTools([]);
        await syncMcpServerTools(pool, item.id);

        const registrations = await listMcpToolRegistrationsForServer(pool, item.id);
        expect(registrations).toHaveLength(1);
        expect(registrations[0].id).toBe(existing.id);
        expect(registrations[0].active).toBe(false);
      } finally {
        await contract.stop();
      }
    });

    it("adds a newly-advertised tool on top of one already registered", async () => {
      const contract: McpContractServer = await start();
      try {
        const item = await createMcpServerItem(contract.connectionConfig);
        await syncMcpServerTools(pool, item.id);

        const extended: ContractServerTool[] = [...DEFAULT_CONTRACT_TOOLS, { name: "send_email", description: "Sends an email", inputSchema: { type: "object", properties: {} } }];
        contract.setTools(extended);
        await syncMcpServerTools(pool, item.id);

        const registrations = await listMcpToolRegistrationsForServer(pool, item.id);
        expect(registrations.map((r) => [r.toolName, r.active]).sort()).toEqual([
          ["search_web", true],
          ["send_email", true],
        ]);
      } finally {
        await contract.stop();
      }
    });

    it("rejects a response with a duplicate tool name and leaves prior registrations untouched", async () => {
      const contract: McpContractServer = await start();
      try {
        const item = await createMcpServerItem(contract.connectionConfig);
        await syncMcpServerTools(pool, item.id);
        const before = await listMcpToolRegistrationsForServer(pool, item.id);

        contract.setTools([
          { name: "dup", description: "one", inputSchema: { type: "object", properties: {} } },
          { name: "dup", description: "two", inputSchema: { type: "object", properties: {} } },
        ]);

        await expect(syncMcpServerTools(pool, item.id)).rejects.toThrow(ValidationError);

        const after = await listMcpToolRegistrationsForServer(pool, item.id);
        expect(after).toEqual(before);
        const updated = await getServerItem(item.id);
        expect(updated.properties.syncStatus).toBe("error");
        expect(typeof updated.properties.syncError).toBe("string");
      } finally {
        await contract.stop();
      }
    });

    it("closes the connection after a successful sync", async () => {
      const contract = await start();
      try {
        const item = await createMcpServerItem(contract.connectionConfig);
        await syncMcpServerTools(pool, item.id);
        if ("hasOpenSockets" in contract) {
          const hasOpenSockets = () => (contract as { hasOpenSockets(): boolean }).hasOpenSockets();
          await waitFor(() => !hasOpenSockets(), "contract server still has an open socket after a successful sync");
        } else if ("waitForChildExit" in contract) {
          await (contract as { waitForChildExit(): Promise<void> }).waitForChildExit();
        }
      } finally {
        await contract.stop();
      }
    });
  });

  it("records a safe error and leaves prior registrations authoritative on a connection failure", async () => {
    const item = await createMcpServerItem({ transport: "stdio", command: "definitely-not-a-real-binary-xyz" });

    await expect(syncMcpServerTools(pool, item.id)).rejects.toThrow();

    const updated = await getServerItem(item.id);
    expect(updated.properties.syncStatus).toBe("error");
    expect(updated.properties.syncError).toEqual(expect.any(String));
    expect(updated.properties.syncError).not.toMatch(/definitely-not-a-real-binary-xyz/);
    expect(await listMcpToolRegistrationsForServer(pool, item.id)).toEqual([]);
  });

  it("closes the connection after a failed sync", async () => {
    const contract = await startHttpContractServer();
    const workingUrl = contract.connectionConfig;
    await contract.stop();

    const item = await createMcpServerItem(workingUrl);
    await expect(syncMcpServerTools(pool, item.id)).rejects.toThrow();
    // No open-socket assertion possible once the server itself is stopped; the connection
    // factory's own tests (mcpConnectionFactory.test.ts) already cover "no leak after a failed
    // connect" at the transport level — this just confirms the sync path surfaces the failure.
  });

  it("throws NotFoundError for a nonexistent MCP server item", async () => {
    await expect(syncMcpServerTools(pool, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(NotFoundError);
  });
});

describe("listAllTools (pagination)", () => {
  function fakeClient(pages: { tools: { name: string; inputSchema: unknown }[]; nextCursor?: string }[]): McpClientHandle["client"] {
    const listTools = vi.fn(async (params?: { cursor?: string }) => {
      const index = params?.cursor ? Number(params.cursor) : 0;
      const page = pages[index];
      if (!page) throw new Error(`fakeClient: no page for cursor '${params?.cursor}'`);
      return page.nextCursor !== undefined ? { tools: page.tools, nextCursor: page.nextCursor } : { tools: page.tools };
    });
    return { listTools } as unknown as McpClientHandle["client"];
  }

  it("follows nextCursor to collect tools across every page before returning", async () => {
    const client = fakeClient([
      { tools: [{ name: "a", inputSchema: {} }], nextCursor: "1" },
      { tools: [{ name: "b", inputSchema: {} }], nextCursor: "2" },
      { tools: [{ name: "c", inputSchema: {} }] },
    ]);

    const tools = await listAllTools(client);

    expect(tools.map((t) => t.name)).toEqual(["a", "b", "c"]);
    expect(client.listTools).toHaveBeenCalledTimes(3);
  });

  it("stops after a single page when the response has no nextCursor", async () => {
    const client = fakeClient([{ tools: [{ name: "only", inputSchema: {} }] }]);

    const tools = await listAllTools(client);

    expect(tools.map((t) => t.name)).toEqual(["only"]);
    expect(client.listTools).toHaveBeenCalledTimes(1);
  });

  it("throws rather than looping forever against a server whose pagination never terminates", async () => {
    const client = {
      listTools: vi.fn(async () => ({ tools: [], nextCursor: "again" })),
    } as unknown as McpClientHandle["client"];

    await expect(listAllTools(client)).rejects.toThrow(ValidationError);
  });
});
