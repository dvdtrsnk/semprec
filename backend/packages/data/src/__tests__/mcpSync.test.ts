import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob, runOnce } from "@semprec/queue";
import { AiGatewayFailedError, type AiGatewayClientPort, type AiGatewayCompletionInput } from "@semprec/shared";
import { getTenantZeroId, getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import {
  DEFAULT_CONTRACT_TOOLS,
  allowLoopbackOutboundForTests,
  startHttpContractServer,
  startSseContractServer,
  startStdioContractServer,
  type ContractServerTool,
  type McpContractServer,
} from "../testSupport/mcpContractServers.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import {
  enqueueMcpServerSync,
  handleMcpServerSyncTask,
  listAllTools,
  mcpServerSyncJobKey,
  syncMcpServerTools,
} from "../mcp/mcpSync.js";
import type { connectMcpServer as ConnectMcpServerFn, McpClientHandle } from "../mcp/mcpConnectionFactory.js";
import { listMcpToolRegistrationsForServer } from "../mcp/mcpToolRegistrationsStore.js";
import { setMcpToolRequiresApproval, setMcpToolRiskClass } from "../mcp/mcpGrantsAdminStore.js";
import type { McpConnectionConfig } from "../mcp/mcpConnectionConfig.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { logger } from "../mcp/logger.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createActionQueueAffinity, createActionRegistry } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";

/**
 * `connectMock.impl` is what the mocked `connectMcpServer` actually calls — defaults to the real
 * implementation (`connectMock.actual`, captured once the real module loads) and is swapped per
 * test to inject a connection whose `close()` rejects, without touching every other test's
 * use of a genuine contract server. Declared via `vi.hoisted` because the `vi.mock` factory below
 * is hoisted above this file's own top-level statements and needs this object to already exist.
 */
const connectMock = vi.hoisted(() => ({
  impl: undefined as unknown as typeof ConnectMcpServerFn,
  actual: undefined as unknown as typeof ConnectMcpServerFn,
}));

vi.mock("../mcp/mcpConnectionFactory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/mcpConnectionFactory.js")>();
  connectMock.actual = actual.connectMcpServer;
  connectMock.impl = actual.connectMcpServer;
  return {
    ...actual,
    connectMcpServer: ((...args: Parameters<typeof ConnectMcpServerFn>) =>
      connectMock.impl(...args)) as typeof ConnectMcpServerFn,
  };
});

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
    itemsStore.insertItem(client, {
      databaseId: mcpServersId,
      properties: { name: "Contract server", connectionConfig },
    }),
  );
  if (credential !== undefined) {
    await withTransaction(pool, (client) =>
      storeCredential(client, { itemId: item.id, credentialType: "api_key", plaintext: credential }),
    );
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
    // A `stdio` spawn needs an admin of tenant zero (issue #1033).
    const tenantId = getTenantZeroId();
    await createUser(pool, {
      email: "admin@example.test",
      passwordHash: "unused",
      tenantId,
      role: "admin",
    });
    connectMock.impl = connectMock.actual;
  });

  // The sse/http contract servers listen on loopback, which the default outbound policy refuses.
  let restoreOutboundPolicy: () => void;
  beforeAll(() => {
    restoreOutboundPolicy = allowLoopbackOutboundForTests();
  });

  afterAll(() => {
    restoreOutboundPolicy();
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
        const first = (await listMcpToolRegistrationsForServer(pool, item.id))[0]!;
        await setMcpToolRiskClass(pool, first.id, "high");
        await setMcpToolRequiresApproval(pool, first.id, false);

        contract.setTools([
          {
            name: "search_web",
            description: "Updated description",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
          },
        ]);
        await syncMcpServerTools(pool, item.id);

        const resynced = (await listMcpToolRegistrationsForServer(pool, item.id))[0]!;
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
        const existing = (await listMcpToolRegistrationsForServer(pool, item.id))[0]!;

        contract.setTools([]);
        await syncMcpServerTools(pool, item.id);

        const registrations = await listMcpToolRegistrationsForServer(pool, item.id);
        expect(registrations).toHaveLength(1);
        expect(registrations[0]!.id).toBe(existing.id);
        expect(registrations[0]!.active).toBe(false);
      } finally {
        await contract.stop();
      }
    });

    it("adds a newly-advertised tool on top of one already registered", async () => {
      const contract: McpContractServer = await start();
      try {
        const item = await createMcpServerItem(contract.connectionConfig);
        await syncMcpServerTools(pool, item.id);

        const extended: ContractServerTool[] = [
          ...DEFAULT_CONTRACT_TOOLS,
          { name: "send_email", description: "Sends an email", inputSchema: { type: "object", properties: {} } },
        ];
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

  it("keeps the original sync error when closing the connection also fails (issue #781)", async () => {
    const contract = startStdioContractServer([
      { name: "dup", description: "one", inputSchema: { type: "object", properties: {} } },
      { name: "dup", description: "two", inputSchema: { type: "object", properties: {} } },
    ]);
    const closeErr = new Error("close failed: ECONNRESET");
    const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const item = await createMcpServerItem(contract.connectionConfig);
      connectMock.impl = async (...args: Parameters<typeof ConnectMcpServerFn>) => {
        const handle = await connectMock.actual(...args);
        return { ...handle, close: () => Promise.reject(closeErr) };
      };

      // The duplicate tool name fails strict validation after the connection is already open,
      // so both the sync error and the close failure are in flight when `finally` runs.
      await expect(syncMcpServerTools(pool, item.id)).rejects.toThrow(ValidationError);

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        { err: closeErr, mcpServerItemId: item.id },
        "syncMcpServerTools: failed to close the MCP client handle",
      );
    } finally {
      loggerErrorSpy.mockRestore();
      await contract.stop();
    }
  });

  it("still throws the close failure when the sync itself succeeds (issue #781)", async () => {
    const contract = startStdioContractServer();
    const closeErr = new Error("close failed: ECONNRESET");
    try {
      const item = await createMcpServerItem(contract.connectionConfig);
      connectMock.impl = async (...args: Parameters<typeof ConnectMcpServerFn>) => {
        const handle = await connectMock.actual(...args);
        return { ...handle, close: () => Promise.reject(closeErr) };
      };

      await expect(syncMcpServerTools(pool, item.id)).rejects.toThrow(closeErr);
    } finally {
      await contract.stop();
    }
  });

  it("throws NotFoundError for a nonexistent MCP server item", async () => {
    await expect(syncMcpServerTools(pool, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(NotFoundError);
  });

  describe("a server item that goes to the Trash while its tools are listed (issue gh-1984)", () => {
    /** Trashes the server item through the choke point and returns the row as the Trash left it. */
    async function trashServer(itemId: string) {
      await withTransaction(pool, (client) =>
        itemDeleteWithClient(client, mcpServersId, itemId, { queueAffinity: createActionQueueAffinity() }),
      );
      return getServerItem(itemId);
    }

    it("writes no registration and no status, announces nothing and still closes the connection", async () => {
      const contract = startStdioContractServer();
      try {
        const item = await createMcpServerItem(contract.connectionConfig);
        const closes = vi.fn();
        let trashed: Awaited<ReturnType<typeof getServerItem>> | undefined;
        connectMock.impl = async (...args: Parameters<typeof ConnectMcpServerFn>) => {
          const handle = await connectMock.actual(...args);
          trashed = await trashServer(item.id);
          return {
            ...handle,
            close: async () => {
              closes();
              await handle.close();
            },
          };
        };
        const announcements: InvalidationEvent[] = [];
        setInvalidationHook((event) => announcements.push(event));
        // A sync that stops because its server item is gone is no failure to log: the item has no status to record.
        const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

        try {
          await expect(syncMcpServerTools(pool, item.id)).rejects.toThrow(NotFoundError);
          expect(loggerErrorSpy).not.toHaveBeenCalled();
        } finally {
          setInvalidationHook(() => {});
          loggerErrorSpy.mockRestore();
        }

        expect(await listMcpToolRegistrationsForServer(pool, item.id)).toEqual([]);
        expect(await getServerItem(item.id)).toEqual(trashed);
        expect(announcements.filter((event) => event.scope === "mcpServers")).toEqual([]);
        expect(closes).toHaveBeenCalledOnce();
      } finally {
        await contract.stop();
      }
    });

    it("records no failure on the trashed item when the sync itself failed", async () => {
      const contract = startStdioContractServer([
        { name: "dup", description: "one", inputSchema: { type: "object", properties: {} } },
        { name: "dup", description: "two", inputSchema: { type: "object", properties: {} } },
      ]);
      try {
        const item = await createMcpServerItem(contract.connectionConfig);
        let trashed: Awaited<ReturnType<typeof getServerItem>> | undefined;
        connectMock.impl = async (...args: Parameters<typeof ConnectMcpServerFn>) => {
          const handle = await connectMock.actual(...args);
          trashed = await trashServer(item.id);
          return handle;
        };

        const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
        try {
          await expect(syncMcpServerTools(pool, item.id)).rejects.toThrow(ValidationError);
          expect(loggerErrorSpy).not.toHaveBeenCalled();
        } finally {
          loggerErrorSpy.mockRestore();
        }

        expect(trashed?.deletedAt).not.toBeNull();
        expect(await getServerItem(item.id)).toEqual(trashed);
      } finally {
        await contract.stop();
      }
    });
  });

  describe("tool schema policy (issue #696)", () => {
    it("rejects a catastrophic-backtracking pattern, records a fixed error, and writes no registration", async () => {
      const contract = startStdioContractServer([
        {
          name: "search_web",
          description: "Searches the web",
          inputSchema: { type: "object", properties: { q: { type: "string", pattern: "(a+)+$" } } },
        },
      ]);
      try {
        const item = await createMcpServerItem(contract.connectionConfig);

        await expect(syncMcpServerTools(pool, item.id)).rejects.toThrow(ValidationError);

        expect(await listMcpToolRegistrationsForServer(pool, item.id)).toEqual([]);
        const updated = await getServerItem(item.id);
        expect(updated.properties.syncStatus).toBe("error");
        expect(typeof updated.properties.syncError).toBe("string");
      } finally {
        await contract.stop();
      }
    });

    it("rejects a remote $ref and writes no registration", async () => {
      const contract = startStdioContractServer([
        {
          name: "search_web",
          description: "Searches the web",
          inputSchema: {
            type: "object",
            properties: { q: { $ref: "https://evil.example/schema.json" } as unknown as Record<string, unknown> },
          },
        },
      ]);
      try {
        const item = await createMcpServerItem(contract.connectionConfig);

        await expect(syncMcpServerTools(pool, item.id)).rejects.toThrow(ValidationError);

        expect(await listMcpToolRegistrationsForServer(pool, item.id)).toEqual([]);
      } finally {
        await contract.stop();
      }
    });

    it("rejects a schema over 64 KiB and writes no registration", async () => {
      const contract = startStdioContractServer([
        {
          name: "search_web",
          description: "Searches the web",
          inputSchema: {
            type: "object",
            properties: { q: { type: "string", description: "x".repeat(70 * 1024) } },
          },
        },
      ]);
      try {
        const item = await createMcpServerItem(contract.connectionConfig);

        await expect(syncMcpServerTools(pool, item.id)).rejects.toThrow(ValidationError);

        expect(await listMcpToolRegistrationsForServer(pool, item.id)).toEqual([]);
      } finally {
        await contract.stop();
      }
    });

    it("syncs normally when a pattern is benign", async () => {
      const contract = startStdioContractServer([
        {
          name: "search_web",
          description: "Searches the web",
          inputSchema: { type: "object", properties: { q: { type: "string", pattern: "^[a-z]+$" } } },
        },
      ]);
      try {
        const item = await createMcpServerItem(contract.connectionConfig);

        const result = await syncMcpServerTools(pool, item.id);

        expect(result.toolCount).toBe(1);
        const registrations = await listMcpToolRegistrationsForServer(pool, item.id);
        expect(registrations).toHaveLength(1);
        expect(registrations[0]!.active).toBe(true);
      } finally {
        await contract.stop();
      }
    });
  });
});

describe("listAllTools (pagination)", () => {
  function fakeClient(pages: { tools: { name: string; inputSchema: unknown }[]; nextCursor?: string }[]): {
    client: McpClientHandle["client"];
    listTools: ReturnType<typeof vi.fn>;
  } {
    const listTools = vi.fn(async (params?: { cursor?: string }) => {
      const index = params?.cursor ? Number(params.cursor) : 0;
      const page = pages[index];
      if (!page) throw new Error(`fakeClient: no page for cursor '${params?.cursor}'`);
      return page.nextCursor !== undefined ? { tools: page.tools, nextCursor: page.nextCursor } : { tools: page.tools };
    });
    // The mock is handed back alongside the client: reading `client.listTools` off a value
    // typed as the SDK's `Client` yields an unbound method, which is exactly the mistake
    // `unbound-method` exists to catch and not something to assert on.
    return { client: { listTools } as unknown as McpClientHandle["client"], listTools };
  }

  it("follows nextCursor to collect tools across every page before returning", async () => {
    const { client, listTools } = fakeClient([
      { tools: [{ name: "a", inputSchema: {} }], nextCursor: "1" },
      { tools: [{ name: "b", inputSchema: {} }], nextCursor: "2" },
      { tools: [{ name: "c", inputSchema: {} }] },
    ]);

    const tools = await listAllTools(client);

    expect(tools.map((t) => t.name)).toEqual(["a", "b", "c"]);
    expect(listTools).toHaveBeenCalledTimes(3);
  });

  it("stops after a single page when the response has no nextCursor", async () => {
    const { client, listTools } = fakeClient([{ tools: [{ name: "only", inputSchema: {} }] }]);

    const tools = await listAllTools(client);

    expect(tools.map((t) => t.name)).toEqual(["only"]);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("throws rather than looping forever against a server whose pagination never terminates", async () => {
    const client = {
      listTools: vi.fn(async () => ({ tools: [], nextCursor: "again" })),
    } as unknown as McpClientHandle["client"];

    await expect(listAllTools(client)).rejects.toThrow(ValidationError);
  });
});

describe("mcpServerSync job (issue gh-1976)", () => {
  interface JobRow {
    task_identifier: string;
    key: string | null;
    max_attempts: number;
    attempts: number;
    last_error: string | null;
  }

  let actingUserId: string;
  let announcements: InvalidationEvent[];

  /** The pending or failed `mcpServerSync` jobs, read through graphile-worker's public `jobs` view. */
  async function syncJobs(): Promise<JobRow[]> {
    const { rows } = await pool.query<JobRow>(
      `SELECT task_identifier, key, max_attempts, attempts, last_error
         FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key`,
      [CORE_TASK_NAMES.MCP_SERVER_SYNC],
    );
    return rows;
  }

  /**
   * The business payload of the pending `mcpServerSync` jobs. The public `jobs` view has no payload column, so this
   * reads the private table, as the other job tests do (graphile-worker 0.17.3: `_private_jobs.payload` holds the
   * queue envelope, whose `payload` is what `enqueueJob` was given).
   */
  async function syncJobPayloads(): Promise<Record<string, unknown>[]> {
    const { rows } = await pool.query<{ payload: { payload: Record<string, unknown> } }>(
      `SELECT j.payload FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = $1 ORDER BY j.key`,
      [CORE_TASK_NAMES.MCP_SERVER_SYNC],
    );
    return rows.map((row) => row.payload.payload);
  }

  /** Enqueues in a transaction of tenant zero that commits. */
  function enqueue(mcpServerItemId: string): Promise<void> {
    return inTenantZero(() =>
      withTransaction(pool, (client) => enqueueMcpServerSync(client, { mcpServerItemId, actingUserId })),
    );
  }

  /** Runs every due job through the core task list, as the `api` worker does. */
  async function drainQueue(): Promise<void> {
    await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, createActionRegistry()) });
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    mcpServersId = await databaseIdFor("mcpServers");
    actingUserId = (
      await createUser(pool, {
        email: "admin@example.test",
        passwordHash: "unused",
        tenantId: getTenantZeroId(),
        role: "admin",
      })
    ).id;
    connectMock.impl = connectMock.actual;
    announcements = [];
    setInvalidationHook((event) => announcements.push(event));
  });

  let restoreOutboundPolicy: () => void;
  beforeAll(() => {
    restoreOutboundPolicy = allowLoopbackOutboundForTests();
  });

  afterEach(() => {
    setInvalidationHook(() => {});
  });

  afterAll(() => {
    restoreOutboundPolicy();
  });

  it("enqueues one job under the key mcp-server-sync-<id> with a single attempt and a payload without any credential", async () => {
    const item = await createMcpServerItem(
      { transport: "http", url: "https://mcp.example.com/mcp" },
      "sk-super-secret-credential",
    );

    await enqueue(item.id);

    const jobs = await syncJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      task_identifier: "mcpServerSync",
      key: `mcp-server-sync-${item.id}`,
      max_attempts: 1,
      attempts: 0,
    });
    const payloads = await syncJobPayloads();
    expect(payloads).toEqual([{ mcpServerItemId: item.id, actingUserId }]);
    expect(JSON.stringify(payloads)).not.toContain("sk-super-secret-credential");
    expect(mcpServerSyncJobKey(item.id)).toBe(`mcp-server-sync-${item.id}`);
  });

  it("collapses a second enqueue for the same server onto the pending job and keeps one job per server", async () => {
    const first = await createMcpServerItem({ transport: "http", url: "https://mcp.example.com/one" });
    const second = await createMcpServerItem({ transport: "http", url: "https://mcp.example.com/two" });

    await enqueue(first.id);
    await enqueue(first.id);
    await enqueue(second.id);

    expect((await syncJobs()).map((job) => job.key)).toEqual(
      [`mcp-server-sync-${first.id}`, `mcp-server-sync-${second.id}`].sort(),
    );
  });

  it("leaves no job when the transaction of the enqueue rolls back", async () => {
    const item = await createMcpServerItem({ transport: "http", url: "https://mcp.example.com/mcp" });

    await expect(
      inTenantZero(() =>
        withTransaction(pool, async (client) => {
          await enqueueMcpServerSync(client, { mcpServerItemId: item.id, actingUserId });
          throw new Error("rolled back");
        }),
      ),
    ).rejects.toThrow("rolled back");

    expect(await syncJobs()).toEqual([]);
  });

  it("registers the tools of a reachable server, sets syncStatus ok and announces the item change", async () => {
    const contract = await startHttpContractServer();
    try {
      const item = await createMcpServerItem(contract.connectionConfig, "sk-credential");
      await enqueue(item.id);
      announcements.length = 0;

      await drainQueue();

      const registrations = await listMcpToolRegistrationsForServer(pool, item.id);
      expect(registrations.map((r) => [r.toolName, r.active])).toEqual([["search_web", true]]);
      const updated = await getServerItem(item.id);
      expect(updated.properties.syncStatus).toBe("ok");
      expect(updated.properties.syncError).toBeNull();
      expect(announcements).toContainEqual(
        expect.objectContaining({ scope: "item", databaseId: mcpServersId, itemId: item.id, op: "update" }),
      );
      expect(announcements).toContainEqual(expect.objectContaining({ scope: "mcpServers" }));
      // The job completed and left the queue.
      expect(await syncJobs()).toEqual([]);
      // The sync connected as the user whose confirmation queued it.
      const { rows: accesses } = await pool.query<{ actor_id: string | null; purpose: string }>(
        "SELECT actor_id, purpose FROM credential_access_log WHERE item_id = $1",
        [item.id],
      );
      expect(accesses).toEqual([{ actor_id: actingUserId, purpose: "mcp_tool_sync" }]);
    } finally {
      await contract.stop();
    }
  });

  describe("tool label suggestions (issue gh-1983)", () => {
    const gatewayCalls: AiGatewayCompletionInput[] = [];

    function gatewayAnswering(answer: () => unknown): AiGatewayClientPort {
      gatewayCalls.length = 0;
      return {
        complete: async (input) => {
          gatewayCalls.push(input);
          return { content: answer(), usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
    }

    /** Runs every due job through a core task list that was built with `gateway`, as the api worker does. */
    async function drainQueueWithGateway(gateway: AiGatewayClientPort): Promise<void> {
      // `aiGateway` is the twelfth parameter of `createCoreTaskList`; the ones before it keep their defaults.
      const taskList = createCoreTaskList(
        pool,
        createActionRegistry(),
        undefined, // libraryMetadataFetcher
        undefined, // mailSyncAdapters
        undefined, // mailBlobStorage
        undefined, // moduleRegistry
        undefined, // pushSenders
        undefined, // genericOperationApprovalReplay
        undefined, // filesBlobStorage
        undefined, // tenantBlobStorageDirs
        gateway,
      );
      await runOnce({ pgPool: pool, taskList });
    }

    async function storedLabels(id: string): Promise<Record<string, unknown>> {
      const registrations = await listMcpToolRegistrationsForServer(pool, id);
      return Object.fromEntries(
        registrations.map((registration) => [registration.toolName, registration.displayLabel]),
      );
    }

    it("labels the registered tools after a successful queued sync, through the gateway operation of no project", async () => {
      const contract = await startHttpContractServer();
      try {
        const item = await createMcpServerItem(contract.connectionConfig);
        await enqueue(item.id);
        const gateway = gatewayAnswering(() => ({
          labels: [{ toolName: "search_web", cs: "Hledat na webu", en: "Search the web" }],
        }));

        await drainQueueWithGateway(gateway);

        expect(await storedLabels(item.id)).toEqual({ search_web: { cs: "Hledat na webu", en: "Search the web" } });
        expect(gatewayCalls).toHaveLength(1);
        expect(gatewayCalls[0]).toMatchObject({ operation: "mcp_tool_label", projectItemId: null });
        expect((await getServerItem(item.id)).properties.syncStatus).toBe("ok");
        expect(await syncJobs()).toEqual([]);
      } finally {
        await contract.stop();
      }
    });

    it.each(["budget_exceeded", "timeout", "invalid_response"] as const)(
      "ends the job normally, with the tools registered and no label, when the gateway fails with %s",
      async (reason) => {
        const contract = await startHttpContractServer();
        try {
          const item = await createMcpServerItem(contract.connectionConfig);
          await enqueue(item.id);
          const gateway = gatewayAnswering(() => {
            throw new AiGatewayFailedError(reason);
          });

          await drainQueueWithGateway(gateway);

          expect(gatewayCalls).toHaveLength(1);
          expect(await storedLabels(item.id)).toEqual({ search_web: null });
          expect((await getServerItem(item.id)).properties.syncStatus).toBe("ok");
          // Completed rather than failed: no row is left in the queue.
          expect(await syncJobs()).toEqual([]);
        } finally {
          await contract.stop();
        }
      },
    );

    it("asks the gateway nothing when the sync fails", async () => {
      const contract = await startHttpContractServer();
      const { connectionConfig } = contract;
      await contract.stop();
      const item = await createMcpServerItem(connectionConfig);
      await enqueue(item.id);
      const gateway = gatewayAnswering(() => ({ labels: [] }));

      await drainQueueWithGateway(gateway);

      expect(gatewayCalls).toHaveLength(0);
      expect((await getServerItem(item.id)).properties.syncStatus).toBe("error");
    });

    it("syncs and leaves the labels empty when the task list was built without a gateway", async () => {
      const contract = await startHttpContractServer();
      try {
        const item = await createMcpServerItem(contract.connectionConfig);
        await enqueue(item.id);

        await drainQueue();

        expect(await storedLabels(item.id)).toEqual({ search_web: null });
        expect((await getServerItem(item.id)).properties.syncStatus).toBe("ok");
      } finally {
        await contract.stop();
      }
    });
  });

  it("records syncStatus error with a safe message for an unreachable server, ends without an error and is not retried", async () => {
    const contract = await startHttpContractServer();
    const { connectionConfig } = contract;
    await contract.stop();
    const item = await createMcpServerItem(connectionConfig);
    await enqueue(item.id);

    await drainQueue();

    const updated = await getServerItem(item.id);
    expect(updated.properties.syncStatus).toBe("error");
    expect(updated.properties.syncError).toEqual(expect.any(String));
    expect(await listMcpToolRegistrationsForServer(pool, item.id)).toEqual([]);
    // Completed rather than failed: no row is left to be retried.
    expect(await syncJobs()).toEqual([]);
  });

  it("swallows the tool-list validation failure it has recorded on the item", async () => {
    const contract = await startHttpContractServer();
    try {
      contract.setTools([
        { name: "dup", description: "one", inputSchema: { type: "object", properties: {} } },
        { name: "dup", description: "two", inputSchema: { type: "object", properties: {} } },
      ]);
      const item = await createMcpServerItem(contract.connectionConfig);

      await expect(handleMcpServerSyncTask(pool, { mcpServerItemId: item.id, actingUserId })).resolves.toBeUndefined();

      expect((await getServerItem(item.id)).properties.syncStatus).toBe("error");
      expect(await listMcpToolRegistrationsForServer(pool, item.id)).toEqual([]);
    } finally {
      await contract.stop();
    }
  });

  it("is a no-op for a server item that does not exist", async () => {
    await expect(
      handleMcpServerSyncTask(pool, { mcpServerItemId: randomUUID(), actingUserId }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op for a server item that is in the Trash", async () => {
    const item = await createMcpServerItem({ transport: "http", url: "https://mcp.example.com/mcp" });
    await withTransaction(pool, (client) =>
      itemDeleteWithClient(client, mcpServersId, item.id, { queueAffinity: createActionQueueAffinity() }),
    );
    const connect = vi.fn(connectMock.actual);
    connectMock.impl = connect;

    await expect(handleMcpServerSyncTask(pool, { mcpServerItemId: item.id, actingUserId })).resolves.toBeUndefined();

    expect(connect).not.toHaveBeenCalled();
  });

  it("lets an unexpected error reach the queue, which does not retry it", async () => {
    const item = await createMcpServerItem({ transport: "http", url: "https://mcp.example.com/mcp" });
    connectMock.impl = () => Promise.reject(new Error("unexpected failure"));
    await enqueue(item.id);

    await expect(handleMcpServerSyncTask(pool, { mcpServerItemId: item.id, actingUserId })).rejects.toThrow(
      "unexpected failure",
    );
    await drainQueue();

    // The one allowed attempt is used up: the job stays as a failed one and has no next run.
    const [job] = await syncJobs();
    expect(job).toMatchObject({ attempts: 1, max_attempts: 1, last_error: expect.stringContaining("unexpected") });
    // The sync recorded a fixed message and not the error's own text.
    const updated = await getServerItem(item.id);
    expect(updated.properties.syncError).toBe("MCP tool sync failed for an unexpected reason");
  });

  it.each(["mcpServerItemId", "actingUserId"])(
    "fails a job whose payload lacks the string field %s and connects nowhere",
    async (missing) => {
      const connect = vi.fn(connectMock.actual);
      connectMock.impl = connect;
      const payload: Record<string, unknown> = { mcpServerItemId: randomUUID(), actingUserId };
      delete payload[missing];
      await inTenantZero(() =>
        enqueueJob(pool, CORE_TASK_NAMES.MCP_SERVER_SYNC, payload, { maxAttempts: 1, jobKey: `missing-${missing}` }),
      );

      await drainQueue();

      const [job] = await syncJobs();
      expect(job).toMatchObject({ last_error: `Job payload missing string field '${missing}'` });
      expect(connect).not.toHaveBeenCalled();
    },
  );
});

// Closed once, after every describe of this file has used the pool.
afterAll(async () => {
  await pool?.end();
});
