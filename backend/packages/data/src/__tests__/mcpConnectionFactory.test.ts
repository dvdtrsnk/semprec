import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { startHttpContractServer, startSseContractServer, startStdioContractServer } from "../testSupport/mcpContractServers.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
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
  const item = await withTransaction(pool, (client) => itemsStore.insertItem(client, { databaseId: mcpServersId, properties: { name: "Contract server", connectionConfig } }));
  if (credential !== undefined) {
    await withTransaction(pool, (client) => storeCredential(client, { itemId: item.id, credentialType: "api_key", plaintext: credential }));
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

  describe("stdio", () => {
    it("connects, completes the handshake, and injects the credential into the child's env", async () => {
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

    it("leaves no child process running after a failed connect", async () => {
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
  });

  describe("safe error mapping", () => {
    it("rejects a malformed connectionConfig before opening any connection", async () => {
      const item = await createMcpServerItem({ transport: "carrier-pigeon" } as unknown as McpConnectionConfig);
      const err = await connectMcpServer(pool, item).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpConnectionError);
      expect((err as McpConnectionError).reason).toBe("invalid_config");
    });

    it("rejects a credential decryption failure before opening any connection", async () => {
      const item = await withTransaction(pool, (client) =>
        itemsStore.insertItem(client, { databaseId: mcpServersId, properties: { name: "Bad key version", connectionConfig: { transport: "stdio", command: "irrelevant" } } }),
      );
      // Encrypt under the real (version 1) key, then bump the stored key_version to one with no
      // corresponding `CREDENTIALS_MASTER_KEY_V2` in the test environment, so decryption fails
      // deterministically without needing an actually-corrupt ciphertext.
      await withTransaction(pool, (client) => storeCredential(client, { itemId: item.id, credentialType: "api_key", plaintext: "sk-unreachable" }));
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
