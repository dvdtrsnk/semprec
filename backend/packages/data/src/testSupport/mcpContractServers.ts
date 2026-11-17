import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http, { type Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpConnectionConfig } from "../mcp/mcpConnectionConfig.js";

/** sse/http contract servers listen on `http://127.0.0.1`, which the default outbound policy refuses. */
export { allowLoopbackOutboundForTests } from "../net/outboundAddressPolicy.js";

/**
 * Minimal MCP contract servers for `stdio`, `sse` and `http`, shared by MCP tests so every transport behaves
 * identically. Each completes `initialize`, records the credential it saw (child env for `stdio`, `Authorization`
 * for `sse`/`http`) and tracks its transport resources so a test can assert cleanup.
 *
 * `tools/list` answers a mutable tool set (`setTools`). `tools/call` echoes `{ name, arguments }` as its only text
 * content, or answers `isError: true` when the arguments include `__forceError: true`.
 */

export interface ContractServerTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

/** Advertised until a test calls `setTools`. */
export const DEFAULT_CONTRACT_TOOLS: ContractServerTool[] = [
  {
    name: "search_web",
    description: "Searches the web",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];
export interface ContractToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** `null` when the caller sent no `_meta`. */
  meta: Record<string, unknown> | null;
}

export interface McpContractServer {
  readonly connectionConfig: McpConnectionConfig;
  /** Via header or child env; `null` if none or not yet connected. */
  getObservedCredential(): string | null;
  getHandshakeCount(): number;
  /** Takes effect immediately for sse/http, on the next spawned child for stdio. */
  setTools(tools: ContractServerTool[]): void;
  getLastToolCall(): ContractToolCall | null;
  /** For stdio, also waits briefly for the spawned child to exit. */
  stop(): Promise<void>;
}

const FORCE_ERROR_ARG = "__forceError";
function handleContractToolCall(name: string, args: Record<string, unknown> | undefined) {
  const callArguments = args ?? {};
  if (callArguments[FORCE_ERROR_ARG] === true) {
    return { isError: true, content: [{ type: "text" as const, text: "contract-server-forced-error" }] };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify({ name, arguments: callArguments }) }] };
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
  waitForChildExit(): Promise<void>;
  /** Names (never values) of the env vars the last spawned child saw; `null` before any spawn. */
  getChildEnvironmentNames(): string[] | null;
}

/**
 * Starts no process itself: returns a `connectionConfig` that makes the real connection factory spawn
 * `fixtures/mcpStdioContractServerScript.mjs`. `credentialEnvVar` names the env var the script reports back.
 */
export function startStdioContractServer(
  initialTools: ContractServerTool[] = DEFAULT_CONTRACT_TOOLS,
): StdioContractServer {
  const recordFile = path.join(os.tmpdir(), `mcp-contract-stdio-${randomUUID()}.json`);
  const toolsFile = path.join(os.tmpdir(), `mcp-contract-stdio-tools-${randomUUID()}.json`);
  const credentialEnvVar = "MCP_CONTRACT_TEST_CREDENTIAL";
  const scriptPath = fileURLToPath(new URL("./fixtures/mcpStdioContractServerScript.mjs", import.meta.url));

  writeFileSync(toolsFile, JSON.stringify(initialTools));

  function readRecord(): {
    pid: number;
    handshakeCount: number;
    credential?: string | null;
    lastToolCall?: ContractToolCall | null;
    envNames?: string[];
  } | null {
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
      args: [scriptPath, recordFile, toolsFile],
      env: { MCP_CONTRACT_CREDENTIAL_ENV_VAR: credentialEnvVar },
      credentialEnvVar,
    },
    getObservedCredential: () => readRecord()?.credential ?? null,
    getHandshakeCount: () => readRecord()?.handshakeCount ?? 0,
    getLastToolCall: () => readRecord()?.lastToolCall ?? null,
    getChildEnvironmentNames: () => readRecord()?.envNames ?? null,
    // Read by each newly spawned child at startup; a running child cannot be updated.
    setTools: (tools) => writeFileSync(toolsFile, JSON.stringify(tools)),
    async stop() {
      // The child is the connection factory's to close (a test asserts that via `waitForChildExit`); this handle
      // owns only the two temp files.
      for (const file of [recordFile, toolsFile]) {
        try {
          unlinkSync(file);
        } catch {
          // Already absent, e.g. the child never spawned.
        }
      }
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
  /** Sends `notifications/tools/list_changed` to the connected client, if any. */
  triggerToolsListChanged(): Promise<void>;
}

/** @deprecated transport upstream (`SSEServerTransport`), but still a required contract. */
export async function startSseContractServer(
  initialTools: ContractServerTool[] = DEFAULT_CONTRACT_TOOLS,
): Promise<HttpTransportContractServer> {
  let observedCredential: string | null = null;
  let handshakeCount = 0;
  let currentMcpServer: McpServer | undefined;
  let currentTools = initialTools;
  let lastToolCall: ContractToolCall | null = null;
  const transportsBySession = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer((req, res) => {
    // A failed handler must still end the response, or the test client hangs until its timeout.
    void (async () => {
      const authorization = req.headers.authorization;
      observedCredential = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;

      if (req.method === "GET" && req.url?.startsWith("/sse")) {
        const transport = new SSEServerTransport("/messages", res);
        transportsBySession.set(transport.sessionId, transport);
        res.on("close", () => transportsBySession.delete(transport.sessionId));
        const mcpServer = new McpServer(
          { name: "mcp-contract-sse", version: "1.0.0" },
          { capabilities: { tools: { listChanged: true } } },
        );
        // Reads `currentTools` per request, so `setTools` affects an already-connected session.
        mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: currentTools }));
        mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
          lastToolCall = {
            name: request.params.name,
            arguments: request.params.arguments ?? {},
            meta: request.params._meta ?? null,
          };
          return handleContractToolCall(request.params.name, request.params.arguments);
        });
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
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const handle = await listenOnEphemeralPort(httpServer);

  return {
    connectionConfig: { transport: "sse", url: `http://127.0.0.1:${handle.getPort()}/sse` },
    getObservedCredential: () => observedCredential,
    getHandshakeCount: () => handshakeCount,
    hasOpenSockets: () => handle.sockets.size > 0,
    setTools: (tools) => {
      currentTools = tools;
    },
    getLastToolCall: () => lastToolCall,
    async triggerToolsListChanged() {
      await currentMcpServer?.sendToolListChanged();
    },
    stop: () => closeHttpServer(handle),
  };
}

export async function startHttpContractServer(
  initialTools: ContractServerTool[] = DEFAULT_CONTRACT_TOOLS,
): Promise<HttpTransportContractServer> {
  let observedCredential: string | null = null;
  let handshakeCount = 0;
  let currentTools = initialTools;
  let currentMcpServer: McpServer | undefined;
  let lastToolCall: ContractToolCall | null = null;
  // One `StreamableHTTPServerTransport` is one session, and tests reconnect repeatedly (new sessions), so this
  // keys a transport and `McpServer` per session id, as the SDK's multi-session example does.
  const transportsBySession = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer((req, res) => {
    // As above: a failed handler must still end the response.
    void (async () => {
      const authorization = req.headers.authorization;
      observedCredential = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;

      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
      const existing = sessionId ? transportsBySession.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res);
        return;
      }
      if (sessionId) {
        // Unknown or stale session id, as in the SDK example.
        res.writeHead(400).end();
        return;
      }

      // No session id: must be an `initialize` request; `handleRequest` answers 400 otherwise.
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transportsBySession.set(id, transport);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) transportsBySession.delete(id);
      };
      const mcpServer = new McpServer(
        { name: "mcp-contract-http", version: "1.0.0" },
        { capabilities: { tools: { listChanged: true } } },
      );
      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: currentTools }));
      mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        lastToolCall = {
          name: request.params.name,
          arguments: request.params.arguments ?? {},
          meta: request.params._meta ?? null,
        };
        return handleContractToolCall(request.params.name, request.params.arguments);
      });
      mcpServer.oninitialized = () => {
        handshakeCount += 1;
        currentMcpServer = mcpServer;
      };
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const handle = await listenOnEphemeralPort(httpServer);

  return {
    connectionConfig: { transport: "http", url: `http://127.0.0.1:${handle.getPort()}/mcp` },
    getObservedCredential: () => observedCredential,
    getHandshakeCount: () => handshakeCount,
    hasOpenSockets: () => handle.sockets.size > 0,
    setTools: (tools) => {
      currentTools = tools;
    },
    getLastToolCall: () => lastToolCall,
    async triggerToolsListChanged() {
      await currentMcpServer?.sendToolListChanged();
    },
    async stop() {
      for (const transport of transportsBySession.values()) await transport.close();
      await closeHttpServer(handle);
    },
  };
}
