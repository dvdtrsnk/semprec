import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHttpFailureObserver } from "../mcpHttpFailureObservation.js";

const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "test", arguments: {} } } as const;
const initialize = { jsonrpc: "2.0", id: 2, method: "initialize", params: {} } as const;
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" } as const;

function harness(
  fetch: FetchLike,
  behavior: (message: JSONRPCMessage, fetch: FetchLike, transport: Transport) => Promise<void>,
  hasAuthProvider = false,
) {
  const observer = createMcpHttpFailureObserver(hasAuthProvider);
  const observedFetch = observer.wrapFetch(fetch);
  const transport: Transport = {
    async start() {},
    async close() {},
    send: (message) => behavior(message, observedFetch, transport),
  };
  observer.install(transport);
  return { observer, transport, observedFetch };
}

function post(fetch: FetchLike, message: JSONRPCMessage) {
  return fetch("http://local.test/messages", { method: "POST", body: JSON.stringify(message) });
}

async function terminal(message: JSONRPCMessage, fetch: FetchLike, transport: Transport): Promise<void> {
  const response = await post(fetch, message);
  if (!response.ok) {
    const error = new Error("private-error-sentinel");
    transport.onerror?.(error);
    throw error;
  }
}

describe("correlated MCP HTTP failure observation", () => {
  it.each([call, initialize, initialized])(
    "binds terminal status to the same rejected $method error",
    async (message) => {
      const response = new Response("private-body-sentinel", { status: 403 });
      const { observer, transport, observedFetch } = harness(async () => response, terminal);
      expect(await post(observedFetch, message)).toBe(response);
      const operation = observer.begin();
      const error: unknown = await operation.run(() => transport.send(message)).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(operation.status(new Error("different"))).toBeUndefined();
      expect(operation.status(error)).toBe(403);
      expect(operation.status(error)).toBeUndefined();
      operation.close();
      expect(await response.text()).toBe("private-body-sentinel");
    },
  );

  it("does not treat a provider 401 challenge as a terminal refusal", async () => {
    const { observer, transport } = harness(async () => new Response(null, { status: 401 }), terminal, true);
    const operation = observer.begin();
    const error: unknown = await operation.run(() => transport.send(call)).catch((value: unknown) => value);
    expect(operation.status(error)).toBeUndefined();
    operation.close();
  });

  it("does not infer status for a malformed initialized request with an id", async () => {
    const { observer, transport } = harness(async () => new Response(null, { status: 403 }), terminal);
    const operation = observer.begin();
    const error: unknown = await operation
      .run(() => transport.send({ jsonrpc: "2.0", id: 3, method: "notifications/initialized" }))
      .catch((value: unknown) => value);
    expect(operation.status(error)).toBeUndefined();
    operation.close();
  });

  it("does not reuse an accepted POST or unrelated GET for a later error", async () => {
    const { observer, transport } = harness(
      async (_url, init) => new Response(null, { status: init?.method === "POST" ? 200 : 403 }),
      async (message, fetch, target) => {
        await post(fetch, message);
        await fetch("http://local.test/stream", { method: "GET" });
        const error = new Error("json-rpc error");
        target.onerror?.(error);
        throw error;
      },
    );
    const operation = observer.begin();
    const error: unknown = await operation.run(() => transport.send(call)).catch((value: unknown) => value);
    expect(operation.status(error)).toBeUndefined();
    operation.close();
  });

  it("does not classify a callback replacement error", async () => {
    const observer = createMcpHttpFailureObserver(false);
    const fetch = observer.wrapFetch(async () => new Response(null, { status: 403 }));
    const replacement = new Error("replacement");
    const transport: Transport = {
      async start() {},
      async close() {},
      onerror: () => {
        throw replacement;
      },
      send: (message) => terminal(message, fetch, transport),
    };
    observer.install(transport);
    const operation = observer.begin();
    const error: unknown = await operation.run(() => transport.send(call)).catch((value: unknown) => value);
    expect(error).toBe(replacement);
    expect(operation.status(error)).toBeUndefined();
    operation.close();
  });

  it("passes through a primitive error from a nonconforming transport", async () => {
    const observer = createMcpHttpFailureObserver(false);
    let received: unknown;
    const transport: Transport = {
      async start() {},
      async close() {},
      onerror: (error) => {
        received = error;
      },
      send() {
        // @ts-expect-error Exercise a dependency violating the SDK callback type.
        transport.onerror?.("primitive failure");
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Exercise a nonconforming dependency.
        return Promise.reject("primitive failure");
      },
    };
    observer.install(transport);
    const operation = observer.begin();
    const failure: unknown = await operation.run(() => transport.send(call)).catch((value: unknown) => value);
    expect(failure).toBe("primitive failure");
    expect(received).toBe("primitive failure");
    expect(operation.status(failure)).toBeUndefined();
    operation.close();
  });

  it("does not transfer a parent denial to a failed retry", async () => {
    let attempts = 0;
    const { observer, transport } = harness(
      async () => new Response(null, { status: ++attempts === 1 ? 401 : 500 }),
      async (message, fetch, target) => {
        const response = await post(fetch, message);
        if (response.status === 401) return target.send(message);
        const error = new Error("retry failed");
        target.onerror?.(error);
        throw error;
      },
    );
    const operation = observer.begin();
    const error: unknown = await operation.run(() => transport.send(call)).catch((value: unknown) => value);
    expect(attempts).toBe(2);
    expect(operation.status(error)).toBeUndefined();
    operation.close();
  });

  it("isolates overlapping operations and ignores observations after close", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { observer, transport } = harness(async (_url, init) => {
      if (typeof init?.body === "string" && init.body.includes('"id":1')) {
        started?.();
        await gate;
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 500 });
    }, terminal);
    const first = observer.begin();
    const second = observer.begin();
    const firstResult = first.run(() => transport.send(call)).catch((value: unknown) => value);
    try {
      await arrived;
      const other: unknown = await second.run(() => transport.send(initialize)).catch((value: unknown) => value);
      expect(second.status(other)).toBeUndefined();
      first.close();
    } finally {
      release?.();
    }
    const late: unknown = await firstResult;
    expect(first.status(late)).toBeUndefined();
    second.close();
  });

  it.each([
    ["sse", 401, "success"],
    ["sse", 401, "server-error"],
    ["sse", 401, "tool-error"],
    ["sse", 401, "json-error"],
    ["sse", 401, "auth-error"],
    ["http", 401, "success"],
    ["http", 401, "server-error"],
    ["http", 401, "tool-error"],
    ["http", 401, "json-error"],
    ["http", 403, "success"],
    ["http", 403, "server-error"],
    ["http", 403, "tool-error"],
    ["http", 403, "json-error"],
  ] as const)("preserves real %s SDK OAuth %i retry followed by %s", async (kind, challenge, outcome) => {
    let serverTransport: SSEServerTransport | undefined;
    const httpTransport =
      kind === "http" ? new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() }) : undefined;
    if (httpTransport) {
      const mcp = new McpServer({ name: "retry-http", version: "1" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(CallToolRequestSchema, async () => {
        if (outcome === "json-error") throw new McpError(ErrorCode.InternalError, "test failure");
        return { content: [{ type: "text", text: "ok" }], ...(outcome === "tool-error" ? { isError: true } : {}) };
      });
      await mcp.connect(httpTransport);
    }
    let calls = 0;
    let tokenRequests = 0;
    const server = createServer((req, res) => {
      void (async () => {
        if (req.method === "GET" && req.url === "/sse") {
          serverTransport = new SSEServerTransport("/messages", res);
          const mcp = new McpServer({ name: "retry", version: "1" }, { capabilities: { tools: {} } });
          mcp.setRequestHandler(CallToolRequestSchema, async () => {
            if (outcome === "json-error") throw new McpError(ErrorCode.InternalError, "test failure");
            return { content: [{ type: "text", text: "ok" }], ...(outcome === "tool-error" ? { isError: true } : {}) };
          });
          await mcp.connect(serverTransport);
          return;
        }
        if (req.method === "POST" && req.url === "/token") {
          tokenRequests += 1;
          req.resume();
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ access_token: "refreshed-token", token_type: "Bearer" }));
          return;
        }
        if (req.method === "POST" && (serverTransport || httpTransport)) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            if (!Buffer.isBuffer(chunk)) throw new Error("Expected request bytes");
            chunks.push(chunk);
          }
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (typeof parsed === "object" && parsed !== null && "method" in parsed && parsed.method === "tools/call") {
            calls += 1;
            if (calls === 1) {
              if (challenge === 403)
                res.writeHead(403, { "www-authenticate": 'Bearer error="insufficient_scope", scope="test"' }).end();
              else res.writeHead(401).end();
              return;
            }
            if (outcome === "server-error") {
              res.writeHead(500).end("private-response");
              return;
            }
            if (outcome === "auth-error") {
              res.writeHead(403).end("private-response");
              return;
            }
          }
          if (serverTransport) await serverTransport.handlePostMessage(req, res, parsed);
          else if (httpTransport) await httpTransport.handleRequest(req, res, parsed);
          return;
        }
        if (httpTransport) {
          await httpTransport.handleRequest(req, res);
          return;
        }
        res.writeHead(404).end();
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    const base = `http://127.0.0.1:${address.port}`;
    let token = "initial-token";
    const provider: OAuthClientProvider = {
      redirectUrl: undefined,
      clientMetadata: { redirect_uris: [], grant_types: ["client_credentials"] },
      clientInformation: () => ({ client_id: "local-client", client_secret: "local-secret" }),
      tokens: () => ({ access_token: token, token_type: "Bearer" }),
      saveTokens: (tokens) => {
        token = tokens.access_token;
      },
      redirectToAuthorization: () => {
        throw new Error("unexpected redirect");
      },
      saveCodeVerifier: () => {},
      codeVerifier: () => "unused",
      prepareTokenRequest: () => new URLSearchParams({ grant_type: "client_credentials" }),
      validateResourceURL: async () => undefined,
      discoveryState: () => ({
        authorizationServerUrl: base,
        resourceMetadata: { resource: `${base}/${kind === "sse" ? "sse" : "mcp"}`, authorization_servers: [base] },
        authorizationServerMetadata: {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ["code"],
        },
      }),
    };
    const observer = createMcpHttpFailureObserver(true);
    const options = { authProvider: provider, fetch: observer.wrapFetch(fetch) };
    const transport =
      kind === "sse"
        ? new SSEClientTransport(new URL(`${base}/sse`), options)
        : new StreamableHTTPClientTransport(new URL(`${base}/mcp`), options);
    observer.install(transport);
    const client = new Client({ name: "test", version: "1" });
    try {
      const connecting = observer.begin();
      try {
        await connecting.run(() => client.connect(transport));
      } finally {
        connecting.close();
      }
      const operation = observer.begin();
      try {
        const result: unknown = await operation
          .run(() => client.callTool({ name: "test", arguments: {} }))
          .catch((error: unknown) => error);
        if (outcome === "success") expect(result).toMatchObject({ content: [{ type: "text", text: "ok" }] });
        else if (outcome === "tool-error")
          expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "ok" }] });
        else if (outcome === "auth-error") {
          expect(result).toBeInstanceOf(Error);
          expect(operation.status(result)).toBe(403);
        } else {
          expect(result).toBeInstanceOf(Error);
          expect(operation.status(result)).toBeUndefined();
        }
        expect(calls).toBe(2);
        expect(tokenRequests).toBe(1);
      } finally {
        operation.close();
      }
    } finally {
      await client.close();
      await serverTransport?.close();
      await httpTransport?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
