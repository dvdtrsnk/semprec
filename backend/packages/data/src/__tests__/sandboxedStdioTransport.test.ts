import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  allowLoopbackOutboundForTests,
  startHttpContractServer,
  startSseContractServer,
  startStdioContractServer,
  type StdioContractServer,
} from "../testSupport/mcpContractServers.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { connectMcpServer } from "../mcp/mcpConnectionFactory.js";
import { McpConnectionError } from "../mcp/mcpConnectionError.js";
import type { McpConnectionConfig } from "../mcp/mcpConnectionConfig.js";
import { SandboxedStdioClientTransport } from "../mcp/sandboxedStdioTransport.js";

const SOCKET_ENV = "SEMPREC_MCP_LAUNCH_SOCKET";
const CREDENTIAL = "sk-sandboxed-secret";
const MAX_HEADER_BYTES = 65_536;

let pool: Pool;
let mcpServersId: string;

interface LaunchHeader {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The fake launcher's own check of what crossed the socket; anything else is recorded as `null`. */
function parseHeader(line: string): LaunchHeader | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record: Record<string, unknown> = { ...value };
  const { command, args, env } = record;
  if (Object.keys(record).sort().join(",") !== "args,command,env") return null;
  if (typeof command !== "string") return null;
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) return null;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return null;
  const envEntries = Object.entries(env);
  const parsedEnv: Record<string, string> = {};
  for (const [name, envValue] of envEntries) {
    if (typeof envValue !== "string") return null;
    parsedEnv[name] = envValue;
  }
  return { command, args, env: parsedEnv };
}

type LauncherMode = "spawn" | "closeWithoutAnswering" | "neverClose";

interface FakeLauncher {
  readonly socketPath: string;
  /** Every header line received, parsed (`null` when it was not a valid header). */
  readonly headers: (LaunchHeader | null)[];
  spawnedCount(): number;
  childExitCount(): number;
  openConnections(): number;
  stop(): Promise<void>;
}

/**
 * Stands in for `deploy/bin/semprec-mcp-launch` behind its systemd socket: reads the header line,
 * then (in `spawn` mode) runs the command with exactly the header's `env` and forwards the bytes
 * after the header to its stdin, its stdout back to the socket, and closes the connection when the
 * child exits. `allowHalfOpen` keeps the socket writable after the client's EOF, as systemd's
 * accepted socket is, so the child's last answer still reaches the client.
 */
async function startFakeLauncher(mode: LauncherMode): Promise<FakeLauncher> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "semprec-mcp-launch-"));
  const socketPath = path.join(directory, "launch.sock");
  const headers: (LaunchHeader | null)[] = [];
  const sockets = new Set<net.Socket>();
  let spawned = 0;
  let exited = 0;

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      // The client destroying its end mid-test is expected; the test asserts on the outcome.
    });
    let pending = Buffer.alloc(0);
    const onHeaderData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf("\n");
      if (newline === -1) {
        if (pending.length > MAX_HEADER_BYTES) socket.destroy();
        return;
      }
      socket.off("data", onHeaderData);
      const header = parseHeader(pending.toString("utf8", 0, newline));
      headers.push(header);
      const rest = pending.subarray(newline + 1);
      if (mode === "closeWithoutAnswering" || header === null) {
        socket.end();
        return;
      }
      if (mode === "neverClose") return;
      const child = spawn(header.command, header.args, { env: header.env, stdio: ["pipe", "pipe", "inherit"] });
      spawned += 1;
      child.stdin.on("error", () => {
        // The child may exit before consuming everything; its exit closes the connection below.
      });
      if (rest.length > 0) child.stdin.write(rest);
      socket.on("data", (data: Buffer) => child.stdin.write(data));
      socket.on("end", () => child.stdin.end());
      child.stdout.on("data", (data: Buffer) => socket.write(data));
      child.on("close", () => {
        exited += 1;
        socket.end();
      });
    };
    socket.on("data", onHeaderData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    headers,
    spawnedCount: () => spawned,
    childExitCount: () => exited,
    openConnections: () => sockets.size,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
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

/** A `stdio` spawn needs an admin of the sole tenant (issue #1033). */
async function makeSoleTenantAdmin(): Promise<void> {
  const { rows } = await pool.query<{ id: string | null }>("SELECT app_sole_tenant() AS id");
  const tenantId = requireSingleRow(rows, "sole tenant").id;
  if (!tenantId) throw new Error("Expected a sole tenant");
  await createUser(pool, { email: "admin@example.test", passwordHash: "unused", tenantId, role: "admin" });
}

async function credentialAccessLogCount(itemId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM credential_access_log WHERE item_id = $1",
    [itemId],
  );
  return rows[0]?.count;
}

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

function expectConnectionError(err: unknown, reason: McpConnectionError["reason"]): void {
  if (!(err instanceof McpConnectionError)) throw new Error("Expected an McpConnectionError");
  expect(err.reason).toBe(reason);
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("Expected the promise to reject");
}

/** Records every socket the transport opens, so a test can assert none is left open. */
function spyOnCreatedSockets(): net.Socket[] {
  const created: net.Socket[] = [];
  const original = net.createConnection.bind(net);
  vi.spyOn(net, "createConnection").mockImplementation((...args: Parameters<typeof net.createConnection>) => {
    const socket = original(...args);
    created.push(socket);
    return socket;
  });
  return created;
}

describe("sandboxed stdio MCP transport (issue #1070)", () => {
  let restoreOutboundPolicy: (() => void) | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const contracts: StdioContractServer[] = [];

  beforeAll(() => {
    // The sse/http contract servers listen on loopback, which the default outbound policy refuses.
    restoreOutboundPolicy = allowLoopbackOutboundForTests();
  });
  afterAll(() => {
    restoreOutboundPolicy?.();
  });

  beforeEach(async () => {
    for (const name of [SOCKET_ENV, "NODE_ENV"]) savedEnv[name] = process.env[name];
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'mcpServers'");
    mcpServersId = requireSingleRow(rows, "mcpServers database").id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const contract of contracts.splice(0)) await contract.stop();
  });

  function stdioContract(): StdioContractServer {
    const contract = startStdioContractServer();
    contracts.push(contract);
    return contract;
  }

  describe("with SEMPREC_MCP_LAUNCH_SOCKET set", () => {
    it("completes the handshake through the launcher with only the configured env and the credential", async () => {
      await makeSoleTenantAdmin();
      const launcher = await startFakeLauncher("spawn");
      const parentSecretName = "SEMPREC_TEST_PARENT_SECRET";
      const previousSecret = process.env[parentSecretName];
      try {
        process.env[SOCKET_ENV] = launcher.socketPath;
        process.env[parentSecretName] = "parent-only-value";
        const contract = stdioContract();
        const item = await createMcpServerItem(contract.connectionConfig, CREDENTIAL);

        const handle = await connectMcpServer(pool, item, { purpose: "test" });
        try {
          await waitFor(() => contract.getHandshakeCount() === 1, "the launched server never completed the handshake");
          expect(contract.getObservedCredential()).toBe(CREDENTIAL);
          expect(launcher.headers).toHaveLength(1);
          const header = launcher.headers[0];
          expect(header).not.toBeNull();
          expect(header?.env).toEqual({
            MCP_CONTRACT_CREDENTIAL_ENV_VAR: "MCP_CONTRACT_TEST_CREDENTIAL",
            MCP_CONTRACT_TEST_CREDENTIAL: CREDENTIAL,
          });
          expect(header?.env).not.toHaveProperty(parentSecretName);
          expect(header?.command).toBe(process.execPath);
          expect(header?.args).toEqual(
            contract.connectionConfig.transport === "stdio" ? contract.connectionConfig.args : undefined,
          );
          expect(safeStringify(handle.client)).not.toContain(CREDENTIAL);
        } finally {
          await handle.close();
        }
        // `close()` ends the socket: the server reads EOF on its stdin and exits.
        await contract.waitForChildExit();
        await waitFor(() => launcher.childExitCount() === 1, "the launched server never exited after close()");
        await waitFor(() => launcher.openConnections() === 0, "the launcher still has an open connection");
      } finally {
        if (previousSecret === undefined) delete process.env[parentSecretName];
        else process.env[parentSecretName] = previousSecret;
        await launcher.stop();
      }
    });

    it("rejects with handshake_failed and leaves no open socket when the socket path does not exist", async () => {
      await makeSoleTenantAdmin();
      const directory = mkdtempSync(path.join(os.tmpdir(), "semprec-mcp-launch-missing-"));
      try {
        process.env[SOCKET_ENV] = path.join(directory, "absent.sock");
        const created = spyOnCreatedSockets();
        const contract = stdioContract();
        const item = await createMcpServerItem(contract.connectionConfig, CREDENTIAL);

        const err = await captureRejection(connectMcpServer(pool, item));
        expectConnectionError(err, "handshake_failed");
        expect(safeStringify(err)).not.toContain(CREDENTIAL);
        expect(created).toHaveLength(1);
        expect(created.every((socket) => socket.destroyed)).toBe(true);
        expect(contract.getHandshakeCount()).toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("rejects with handshake_failed and leaves no open socket when the launcher closes without answering", async () => {
      await makeSoleTenantAdmin();
      const launcher = await startFakeLauncher("closeWithoutAnswering");
      try {
        process.env[SOCKET_ENV] = launcher.socketPath;
        const created = spyOnCreatedSockets();
        const contract = stdioContract();
        const item = await createMcpServerItem(contract.connectionConfig, CREDENTIAL);

        const err = await captureRejection(connectMcpServer(pool, item));
        expectConnectionError(err, "handshake_failed");
        expect(created).toHaveLength(1);
        expect(created.every((socket) => socket.destroyed)).toBe(true);
        expect(launcher.headers).toHaveLength(1);
        expect(launcher.spawnedCount()).toBe(0);
        await waitFor(() => launcher.openConnections() === 0, "the launcher still has an open connection");
      } finally {
        await launcher.stop();
      }
    });
  });

  describe("without SEMPREC_MCP_LAUNCH_SOCKET outside tests", () => {
    it.each([
      ["unset", undefined],
      ["empty", ""],
    ])("refuses a stdio connect with stdio_sandbox_unavailable when the socket is %s", async (_label, socketValue) => {
      await makeSoleTenantAdmin();
      const contract = stdioContract();
      const item = await createMcpServerItem(contract.connectionConfig, CREDENTIAL);
      process.env.NODE_ENV = "production";
      if (socketValue === undefined) delete process.env[SOCKET_ENV];
      else process.env[SOCKET_ENV] = socketValue;

      const err = await captureRejection(connectMcpServer(pool, item));
      expectConnectionError(err, "stdio_sandbox_unavailable");
      expect(await credentialAccessLogCount(item.id)).toBe("0");
      expect(contract.getChildEnvironmentNames()).toBeNull();
      expect(contract.getHandshakeCount()).toBe(0);
    });

    it.each([
      ["sse", startSseContractServer],
      ["http", startHttpContractServer],
    ])("still connects an %s server", async (_label, startContract) => {
      const contract = await startContract();
      try {
        const item = await createMcpServerItem(contract.connectionConfig, "sk-remote-secret");
        process.env.NODE_ENV = "production";
        delete process.env[SOCKET_ENV];
        const handle = await connectMcpServer(pool, item);
        try {
          expect(contract.getHandshakeCount()).toBe(1);
          expect(contract.getObservedCredential()).toBe("sk-remote-secret");
        } finally {
          await handle.close();
        }
      } finally {
        await contract.stop();
      }
    });
  });

  describe("SandboxedStdioClientTransport.close()", () => {
    it("destroys the socket after the grace period when the launcher never closes, firing onclose once", async () => {
      const launcher = await startFakeLauncher("neverClose");
      try {
        const created = spyOnCreatedSockets();
        const transport = new SandboxedStdioClientTransport(launcher.socketPath, {
          command: "unused",
          args: [],
          env: {},
        });
        let closeCount = 0;
        transport.onclose = () => {
          closeCount += 1;
        };
        await transport.start();
        await waitFor(() => launcher.headers.length === 1, "the launcher never received the header");

        const startedAt = Date.now();
        await transport.close();
        const elapsed = Date.now() - startedAt;
        expect(elapsed).toBeGreaterThanOrEqual(1_900);
        expect(elapsed).toBeLessThan(4_000);
        expect(created).toHaveLength(1);
        expect(created[0]?.destroyed).toBe(true);
        await transport.close();
        expect(closeCount).toBe(1);
        await expect(transport.send({ jsonrpc: "2.0", method: "ping", id: 1 })).rejects.toThrow("Not connected");
      } finally {
        await launcher.stop();
      }
    });
  });
});
