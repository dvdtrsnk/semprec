import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http, { type Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpConnectionConfig } from "../mcp/mcpConnectionConfig.js";

/**
 * Minimal MCP contract servers for `stdio`, `sse`, and `http` (issue #231): each completes the
 * `initialize` handshake, records the credential it observed (from the child process env for
 * `stdio`, from the `Authorization` header for `sse`/`http`), and tracks its own transport-level
 * resources so a test can assert cleanup left nothing behind. `mcpConnectionFactory.test.ts`
 * (this issue) and later #125/#128 tests import these rather than each standing up their own
 * fake server, so all three run against identical behavior.
 */
export interface McpContractServer {
  /** A ready-to-use `mcpServers.connectionConfig` pointing at this running contract server. */
  readonly connectionConfig: McpConnectionConfig;
  /** The credential the server last observed (via header or child env), or `null` if none/not yet connected. */
  getObservedCredential(): string | null;
  /** How many `initialize`/`initialized` handshakes this server has completed. */
  getHandshakeCount(): number;
  /** Stops the contract server (and, for stdio, waits briefly for the spawned child to have exited). */
  stop(): Promise<void>;
}

const CONNECT_POLL_INTERVAL_MS = 20;
const CONNECT_POLL_TIMEOUT_MS = 5_000;

async function pollUntil(predicate: () => boolean, timeoutMs = CONNECT_POLL_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("mcpContractServers: timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_INTERVAL_MS));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StdioContractServer extends McpContractServer {
  /** Waits (with a short timeout) until the spawned child process is no longer running. */
  waitForChildExit(): Promise<void>;
}

/**
 * Spawns via `StdioClientTransport`'s own `command`/`args` — this factory doesn't start a
 * process itself, it only returns the `connectionConfig` that will cause the real connection
 * factory to spawn `testSupport/fixtures/mcpStdioContractServerScript.mjs` as a child of
 * whichever test connects to it. `credentialEnvVar` names the env var that script reports the
 * credential back under (see that file's header comment).
 */
export function startStdioContractServer(): StdioContractServer {
  const recordFile = path.join(os.tmpdir(), `mcp-contract-stdio-${randomUUID()}.json`);
  const credentialEnvVar = "MCP_CONTRACT_TEST_CREDENTIAL";
  const scriptPath = fileURLToPath(new URL("./fixtures/mcpStdioContractServerScript.mjs", import.meta.url));

  function readRecord(): { pid: number; initialized: boolean; credential?: string | null } | null {
    if (!existsSync(recordFile)) return null;
    try {
      return JSON.parse(readFileSync(recordFile, "utf8"));
    } catch {
      return null;
    }
  }

  return {
    connectionConfig: {
      transport: "stdio",
      command: process.execPath,
      args: [scriptPath, recordFile],
      env: { MCP_CONTRACT_CREDENTIAL_ENV_VAR: credentialEnvVar },
      credentialEnvVar,
    },
    getObservedCredential: () => readRecord()?.credential ?? null,
    getHandshakeCount: () => (readRecord()?.initialized ? 1 : 0),
    async stop() {
      // Nothing owned by this handle itself runs persistently — the spawned child is the
      // connection factory's to close; `waitForChildExit` (below) is what a test calls after
      // `handle.close()` to assert that actually happened.
    },
    async waitForChildExit() {
      await pollUntil(() => {
        const record = readRecord();
        return record === null || !isProcessAlive(record.pid);
      });
    },
  };
}

interface HttpContractServerHandle {
  readonly httpServer: HttpServer;
  readonly sockets: Set<Socket>;
  getPort(): number;
}

async function listenOnEphemeralPort(httpServer: HttpServer): Promise<HttpContractServerHandle> {
  const sockets = new Set<Socket>();
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { httpServer, sockets, getPort: () => port };
}

async function closeHttpServer(handle: HttpContractServerHandle): Promise<void> {
  for (const socket of handle.sockets) socket.destroy();
  await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
}

export interface HttpTransportContractServer extends McpContractServer {
  /** True while any transport-level socket to this server remains open. */
  hasOpenSockets(): boolean;
  /** Sends `notifications/tools/list_changed` to the currently connected client, if any — for the "structural non-reactivity" acceptance criterion. */
  triggerToolsListChanged(): Promise<void>;
}

/** @deprecated transport (SSEServerTransport itself is deprecated upstream) but still a required contract per issue #231's scope. */
export async function startSseContractServer(): Promise<HttpTransportContractServer> {
  let observedCredential: string | null = null;
  let handshakeCount = 0;
  let currentMcpServer: McpServer | undefined;
  const transportsBySession = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const authorization = req.headers.authorization;
      observedCredential = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;

      if (req.method === "GET" && req.url?.startsWith("/sse")) {
        const transport = new SSEServerTransport("/messages", res);
        transportsBySession.set(transport.sessionId, transport);
        res.on("close", () => transportsBySession.delete(transport.sessionId));
        const mcpServer = new McpServer({ name: "mcp-contract-sse", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
        mcpServer.oninitialized = () => {
          handshakeCount += 1;
          currentMcpServer = mcpServer;
        };
        await mcpServer.connect(transport);
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/messages")) {
        const sessionId = new URL(req.url, "http://localhost").searchParams.get("sessionId");
        const transport = sessionId ? transportsBySession.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(400).end();
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end();
    })();
  });

  const handle = await listenOnEphemeralPort(httpServer);

  return {
    connectionConfig: { transport: "sse", url: `http://127.0.0.1:${handle.getPort()}/sse` },
    getObservedCredential: () => observedCredential,
    getHandshakeCount: () => handshakeCount,
    hasOpenSockets: () => handle.sockets.size > 0,
    async triggerToolsListChanged() {
      await currentMcpServer?.sendToolListChanged();
    },
    stop: () => closeHttpServer(handle),
  };
}

export async function startHttpContractServer(): Promise<HttpTransportContractServer> {
  let observedCredential: string | null = null;
  let handshakeCount = 0;

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  const mcpServer = new McpServer({ name: "mcp-contract-http", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
  mcpServer.oninitialized = () => {
    handshakeCount += 1;
  };
  await mcpServer.connect(transport);

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const authorization = req.headers.authorization;
      observedCredential = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
      await transport.handleRequest(req, res);
    })();
  });

  const handle = await listenOnEphemeralPort(httpServer);

  return {
    connectionConfig: { transport: "http", url: `http://127.0.0.1:${handle.getPort()}/mcp` },
    getObservedCredential: () => observedCredential,
    getHandshakeCount: () => handshakeCount,
    hasOpenSockets: () => handle.sockets.size > 0,
    async triggerToolsListChanged() {
      await mcpServer.sendToolListChanged();
    },
    async stop() {
      await transport.close();
      await closeHttpServer(handle);
    },
  };
}
