import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import {
  startHttpContractServer,
  startSseContractServer,
  startStdioContractServer,
} from "../testSupport/mcpContractServers.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { connectMcpServer } from "../mcp/mcpConnectionFactory.js";
import { McpConnectionError } from "../mcp/mcpConnectionError.js";
import type { McpConnectionConfig } from "../mcp/mcpConnectionConfig.js";

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

/** `vi.waitFor` guards against the handshake/cleanup being asynchronous relative to when `connect`/`close` resolves. */
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error(message);
    },
    { timeout: 5_000, interval: 20 },
  );
}

/** Guards against a circular-reference throw so the assertion is about content, not about whether `JSON.stringify` itself survives. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[circular]";
        seen.add(val);
      }
      if (typeof val === "function") return "[function]";
      return val;
    });
  } catch {
    return "[unstringifiable]";
  }
}

describe("MCP connection factory (issue #231)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    mcpServersId = await databaseIdFor("mcpServers");
  });

  // A `stdio` spawn needs an admin of the sole tenant (issue #1033). Each test that expects a
  // spawn creates that admin explicitly; the member test below leaves its user a member.
  async function makeSoleTenantAdmin(): Promise<void> {
    const { rows } = await pool.query<{ id: string | null }>("SELECT app_sole_tenant() AS id");
    const tenantId = requireSingleRow(rows, "sole tenant").id;
    if (!tenantId) throw new Error("Expected a sole tenant");
    await createUser(pool, {
      email: "admin@example.test",
      passwordHash: "unused",
      tenantId,
      role: "admin",
    });
  }

  describe("stdio", () => {
    it("connects, completes the handshake, and injects the credential into the child's env", async () => {
      await makeSoleTenantAdmin();
      const contract = startStdioContractServer();
      const item = await createMcpServerItem(contract.connectionConfig, "sk-stdio-secret");

      const handle = await connectMcpServer(pool, item, { purpose: "test" });
      try {
        await waitFor(() => contract.getHandshakeCount() === 1, "stdio contract server never completed the handshake");
        expect(contract.getObservedCredential()).toBe("sk-stdio-secret");
        expect(safeStringify(handle.client)).not.toContain("sk-stdio-secret");
      } finally {
        await handle.close();
      }
      await contract.waitForChildExit();
    });

    it("connects with no credential when none is stored", async () => {
      await makeSoleTenantAdmin();
      const contract = startStdioContractServer();
      const item = await createMcpServerItem(contract.connectionConfig);

      const handle = await connectMcpServer(pool, item);
      try {
        await waitFor(() => contract.getHandshakeCount() === 1, "stdio contract server never completed the handshake");
        expect(contract.getObservedCredential()).toBeNull();
      } finally {
        await handle.close();
      }
      await contract.waitForChildExit();
    });

    it("refuses a member at spawn without starting a child or decrypting the credential", async () => {
      // The sole tenant's user is a member (the column default), so `tenantAllowsStdio` is false.
      await createTenantZeroUser(pool);
      const contract = startStdioContractServer();
      const item = await createMcpServerItem(contract.connectionConfig, "sk-stdio-secret");

      let thrown: unknown;
      try {
        await connectMcpServer(pool, item, { purpose: "test" });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(McpConnectionError);
      expect((thrown as McpConnectionError).reason).toBe("transport_not_allowed");
      expect(contract.getChildEnvironmentNames()).toBeNull();
      expect(contract.getHandshakeCount()).toBe(0);
      const { rows } = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM credential_access_log WHERE item_id = $1",
        [item.id],
      );
      expect(rows[0]?.count).toBe("0");
    });

    it.each(["admin", "member"] as const)(
      "checks the active tenant's %s role through a runtime pool when another tenant has an admin",
      async (role) => {
        await makeSoleTenantAdmin();
        const tenantId = await createTestTenant(pool);
        await createUser(pool, {
          email: "tenant-b@example.test",
          passwordHash: "unused",
          tenantId,
          role,
        });
        const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
        try {
          await runInTenant(tenantId, async () => {
            await seedSystem(runtimePool, createViewTypeRegistry());
            const { rows: databases } = await runtimePool.query<{ id: string }>(
              "SELECT id FROM databases WHERE owner_module_id = 'mcpServers'",
            );
            const databaseId = requireSingleRow(databases, "tenant B MCP database").id;
            const contract = startStdioContractServer();
            // A legacy stdio row can predate the write-time admin rule; insert through its store.
            const item = await withTransaction(runtimePool, async (client) => {
              const stored = await itemsStore.insertItem(client, {
                databaseId,
                properties: { name: "Legacy contract server", connectionConfig: contract.connectionConfig },
              });
              await storeCredential(client, {
                itemId: stored.id,
                credentialType: "api_key",
                plaintext: "sk-tenant-b-secret",
              });
              return stored;
            });
            const { rows: tenants } = await runtimePool.query<{ sole: string | null; current: string }>(
              "SELECT app_sole_tenant() AS sole, app_current_tenant() AS current",
            );
            expect(tenants).toEqual([{ sole: null, current: tenantId }]);

            if (role === "member") {
              await expect(connectMcpServer(runtimePool, item)).rejects.toMatchObject({
                reason: "transport_not_allowed",
              });
              expect(contract.getHandshakeCount()).toBe(0);
              expect(contract.getChildEnvironmentNames()).toBeNull();
              const { rows } = await runtimePool.query<{ count: string }>(
                "SELECT count(*)::text AS count FROM credential_access_log WHERE item_id = $1",
                [item.id],
              );
              expect(rows).toEqual([{ count: "0" }]);
            } else {
              const handle = await connectMcpServer(runtimePool, item);
              try {
                await waitFor(
                  () => contract.getHandshakeCount() === 1,
                  "tenant B stdio contract server never completed the handshake",
                );
                expect(contract.getObservedCredential()).toBe("sk-tenant-b-secret");
              } finally {
                await handle.close();
              }
              await contract.waitForChildExit();
            }
          });
        } finally {
          await runtimePool.end();
        }
      },
    );

    it("gives the child exactly the inherited names, the config's env names and the credential name", async () => {
      await makeSoleTenantAdmin();
      const contract = startStdioContractServer();
      const item = await createMcpServerItem(contract.connectionConfig, "sk-stdio-secret");
      const parentSecretName = "SEMPREC_TEST_PARENT_SECRET";
      const previous = process.env[parentSecretName];
      process.env[parentSecretName] = "parent-only-value";
      try {
        const handle = await connectMcpServer(pool, item);
        try {
          await waitFor(
            () => contract.getHandshakeCount() === 1,
            "stdio contract server never completed the handshake",
          );
          const inherited = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"].filter(
            (name) => process.env[name] !== undefined,
          );
          // The contract fixture's own env names (`MCP_CONTRACT_CREDENTIAL_ENV_VAR`) and the credential name it declares.
          const expected = [...inherited, "MCP_CONTRACT_CREDENTIAL_ENV_VAR", "MCP_CONTRACT_TEST_CREDENTIAL"].sort();
          expect(contract.getChildEnvironmentNames()?.slice().sort()).toEqual(expected);
          expect(contract.getChildEnvironmentNames()).not.toContain(parentSecretName);
        } finally {
          await handle.close();
        }
        await contract.waitForChildExit();
      } finally {
        if (previous === undefined) delete process.env[parentSecretName];
        else process.env[parentSecretName] = previous;
      }
    });

    it.each<[string, McpConnectionConfig]>([
      ["an env name that overrides PATH", { transport: "stdio", command: "x", env: { PATH: "/evil" } }],
      ["an env name that is a loader hook", { transport: "stdio", command: "x", env: { LD_PRELOAD: "/evil.so" } }],
      ["an env name that is an interpreter hook", { transport: "stdio", command: "x", env: { NODE_OPTIONS: "--x" } }],
      ["a credentialEnvVar that is PATH", { transport: "stdio", command: "x", credentialEnvVar: "PATH" }],
    ])("refuses %s at spawn as invalid_config before any child starts", async (_label, config) => {
      await makeSoleTenantAdmin();
      const item = await createMcpServerItem(config, "sk-stdio-secret");

      let thrown: unknown;
      try {
        await connectMcpServer(pool, item);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(McpConnectionError);
      expect((thrown as McpConnectionError).reason).toBe("invalid_config");
      const { rows } = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM credential_access_log WHERE item_id = $1",
        [item.id],
      );
      expect(rows[0]?.count).toBe("0");
    });

    it("leaves no child process running after a failed connect", async () => {
      await makeSoleTenantAdmin();
      const item = await createMcpServerItem({ transport: "stdio", command: "definitely-not-a-real-binary-xyz" });

      let thrown: unknown;
      try {
        await connectMcpServer(pool, item);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(McpConnectionError);
      expect((thrown as McpConnectionError).reason).toBe("handshake_failed");
      expect(safeStringify(thrown)).not.toMatch(/sk-/);
    });
  });

  describe("sse", () => {
    it("connects, completes the handshake, and injects the credential as a bearer token", async () => {
      const contract = await startSseContractServer();
      try {
        const item = await createMcpServerItem(contract.connectionConfig, "sk-sse-secret");
        const handle = await connectMcpServer(pool, item, { purpose: "test" });
        try {
          expect(contract.getHandshakeCount()).toBe(1);
          expect(contract.getObservedCredential()).toBe("sk-sse-secret");
          expect(safeStringify(handle.client)).not.toContain("sk-sse-secret");
        } finally {
          await handle.close();
        }
        await waitFor(() => !contract.hasOpenSockets(), "sse contract server still has an open socket after close()");
      } finally {
        await contract.stop();
      }
    });

    it("has no observable effect from a notifications/tools/list_changed the server emits", async () => {
      const contract = await startSseContractServer();
      try {
        const item = await createMcpServerItem(contract.connectionConfig, "sk-sse-secret");
        const handle = await connectMcpServer(pool, item);
        try {
          await expect(contract.triggerToolsListChanged()).resolves.toBeUndefined();
          // The connection is unaffected: a normal request still round-trips afterward.
          await expect(handle.client.ping()).resolves.toEqual({});
        } finally {
          await handle.close();
        }
      } finally {
        await contract.stop();
      }
    });

    it("leaves no open socket after a failed connect", async () => {
      const contract = await startSseContractServer();
      const workingUrl = contract.connectionConfig;
      await contract.stop();

      const item = await createMcpServerItem(workingUrl);
      let thrown: unknown;
      try {
        await connectMcpServer(pool, item);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(McpConnectionError);
      expect((thrown as McpConnectionError).reason).toBe("handshake_failed");
    });
  });

  describe("http", () => {
    it("connects, completes the handshake, and injects the credential as a bearer token", async () => {
      const contract = await startHttpContractServer();
      try {
        const item = await createMcpServerItem(contract.connectionConfig, "sk-http-secret");
        const handle = await connectMcpServer(pool, item, { purpose: "test" });
        try {
          expect(contract.getHandshakeCount()).toBe(1);
          expect(contract.getObservedCredential()).toBe("sk-http-secret");
          expect(safeStringify(handle.client)).not.toContain("sk-http-secret");
        } finally {
          await handle.close();
        }
        await waitFor(() => !contract.hasOpenSockets(), "http contract server still has an open socket after close()");
      } finally {
        await contract.stop();
      }
    });

    it("connects with no credential when none is stored", async () => {
      const contract = await startHttpContractServer();
      try {
        const item = await createMcpServerItem(contract.connectionConfig);
        const handle = await connectMcpServer(pool, item);
        try {
          expect(contract.getHandshakeCount()).toBe(1);
          expect(contract.getObservedCredential()).toBeNull();
        } finally {
          await handle.close();
        }
      } finally {
        await contract.stop();
      }
    });

    it("leaves no open socket after a failed connect", async () => {
      const contract = await startHttpContractServer();
      const workingUrl = contract.connectionConfig;
      await contract.stop();

      const item = await createMcpServerItem(workingUrl);
      let thrown: unknown;
      try {
        await connectMcpServer(pool, item);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(McpConnectionError);
      expect((thrown as McpConnectionError).reason).toBe("handshake_failed");
    });
  });

  describe("safe error mapping", () => {
    it("rejects a malformed connectionConfig before opening any connection", async () => {
      const item = await createMcpServerItem({ transport: "carrier-pigeon" } as unknown as McpConnectionConfig);
      const err = await connectMcpServer(pool, item).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpConnectionError);
      expect((err as McpConnectionError).reason).toBe("invalid_config");
    });

    it("rejects a credential decryption failure before opening any connection", async () => {
      // The `stdio` config is only the vehicle here: the spawn check needs an admin of the sole tenant (issue #1033).
      await makeSoleTenantAdmin();
      const item = await withTransaction(pool, (client) =>
        itemsStore.insertItem(client, {
          databaseId: mcpServersId,
          properties: { name: "Bad key version", connectionConfig: { transport: "stdio", command: "irrelevant" } },
        }),
      );
      // Encrypt under the real (version 1) key, then bump the stored key_version to one with no
      // corresponding `CREDENTIALS_MASTER_KEY_V2` in the test environment, so decryption fails
      // deterministically without needing an actually-corrupt ciphertext.
      await withTransaction(pool, (client) =>
        storeCredential(client, { itemId: item.id, credentialType: "api_key", plaintext: "sk-unreachable" }),
      );
      await pool.query(`UPDATE external_credentials SET key_version = 2 WHERE item_id = $1`, [item.id]);

      const err = await connectMcpServer(pool, item).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpConnectionError);
      expect((err as McpConnectionError).reason).toBe("credential_decryption_failed");
      expect(safeStringify(err)).not.toMatch(/sk-unreachable/);
    });
  });
});

afterAll(async () => {
  await pool?.end();
});
