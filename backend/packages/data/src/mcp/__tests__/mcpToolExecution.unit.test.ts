import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

const warn = vi.fn();
vi.mock("@semprec/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@semprec/shared")>()),
  createLogger: () => ({ warn }),
}));

const connectMcpServer = vi.fn();
vi.mock("../mcpConnectionFactory.js", () => ({ connectMcpServer: (...args: unknown[]) => connectMcpServer(...args) }));

const recordSuccess = vi.fn();
const recordFailure = vi.fn();
vi.mock("../mcpServerConnectionStateStore.js", () => ({
  recordMcpConnectionSuccess: (...args: unknown[]) => recordSuccess(...args),
  recordMcpConnectionFailure: (...args: unknown[]) => recordFailure(...args),
}));

const { executeMcpInvocation } = await import("../mcpToolExecution.js");
const { McpConnectionError } = await import("../mcpConnectionError.js");
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");

const POOL = new Pool();
const poolConnect = vi.spyOn(POOL, "connect").mockImplementation(() => {
  throw new Error("Unexpected database connection");
});
const poolQuery = vi.spyOn(POOL, "query").mockImplementation(() => {
  throw new Error("Unexpected database query");
});
afterEach(() => {
  const queries = poolQuery.mock.calls.length;
  const connections = poolConnect.mock.calls.length;
  poolQuery.mockClear();
  poolConnect.mockClear();
  expect(queries).toBe(0);
  expect(connections).toBe(0);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await POOL.end();
});
const TARGET = { serverItem: { id: "server-1", properties: {} }, toolName: "search_web" };

function mockHandle(callTool: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>) {
  connectMcpServer.mockResolvedValue({ client: { callTool }, close });
}

it("rejects accidental pool query and connect without opening a client", () => {
  expect(() => POOL.query("SELECT 1")).toThrow("Unexpected database query");
  expect(() => POOL.connect()).toThrow("Unexpected database connection");
  expect(POOL.totalCount).toBe(0);
  poolQuery.mockClear();
  poolConnect.mockClear();
});

describe("executeMcpInvocation (issue #693)", () => {
  it("resolves the tool's result even when close() rejects afterward", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const close = vi.fn().mockRejectedValue(new Error("close boom"));
    mockHandle(callTool, close);

    const result = await executeMcpInvocation(POOL, TARGET, {});

    expect(result).toEqual({ error: false, result: "ok" });
    expect(close).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ mcpServerItemId: "server-1" }, "MCP connection close failed after tools/call");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("close boom");
  });

  it("resolves the call's own error even when close() also rejects afterward", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("tool boom"));
    const close = vi.fn().mockRejectedValue(new Error("close boom"));
    mockHandle(callTool, close);

    const result = await executeMcpInvocation(POOL, TARGET, {});

    expect(result).toEqual({
      error: true,
      result: "MCP tool call failed for an unexpected reason",
      failure: { failureKind: "toolError", mcpServerItemId: "server-1" },
    });
    expect(close).toHaveBeenCalled();
  });

  it("sends _meta.idempotencyKey when the option is set", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const close = vi.fn().mockResolvedValue(undefined);
    mockHandle(callTool, close);

    await executeMcpInvocation(POOL, TARGET, {}, { idempotencyKey: "abc" });

    expect(callTool.mock.calls[0]![0]).toMatchObject({ _meta: { idempotencyKey: "abc" } });
  });

  it("sends no _meta key when the option is not set", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const close = vi.fn().mockResolvedValue(undefined);
    mockHandle(callTool, close);

    await executeMcpInvocation(POOL, TARGET, {});

    expect(callTool.mock.calls[0]![0]).not.toHaveProperty("_meta");
  });
});

describe("executeMcpInvocation failure classification (issue #1444)", () => {
  const close = vi.fn().mockResolvedValue(undefined);

  it("classifies a tools/call request timeout as timeout with the call timeout", async () => {
    mockHandle(vi.fn().mockRejectedValue(new McpError(ErrorCode.RequestTimeout, "secret detail")), close);
    const result = await executeMcpInvocation(POOL, TARGET, {});
    expect(result).toEqual({
      error: true,
      result: "MCP tool call failed for an unexpected reason",
      failure: { failureKind: "timeout", mcpServerItemId: "server-1", timeoutMs: 60000 },
    });
    expect(JSON.stringify(result.failure)).not.toContain("secret detail");
  });

  it("keeps cancellation and timeout ahead of any observed HTTP status", async () => {
    const callTool = vi.fn().mockRejectedValue(new McpError(ErrorCode.RequestTimeout, "private"));
    connectMcpServer.mockResolvedValue({
      client: { callTool },
      close,
      beginHttpObservation: () => ({
        run: <T>(work: () => Promise<T>) => work(),
        status: () => 403,
        close: () => {},
      }),
    });
    expect((await executeMcpInvocation(POOL, TARGET, {})).failure).toEqual({
      failureKind: "timeout",
      mcpServerItemId: "server-1",
      timeoutMs: 60000,
    });
    const controller = new AbortController();
    controller.abort();
    expect(await executeMcpInvocation(POOL, TARGET, {}, {}, controller.signal)).toEqual({
      error: true,
      result: "MCP tool call was cancelled before it completed",
    });
  });

  it("keeps server exception and close exception details out of failure metadata and logs", async () => {
    warn.mockClear();
    const callTool = vi.fn().mockRejectedValue(new McpError(ErrorCode.RequestTimeout, "server-message-sentinel"));
    const closeWithError = vi.fn().mockRejectedValue(new Error("close-message-sentinel"));
    mockHandle(callTool, closeWithError);
    const result = await executeMcpInvocation(POOL, TARGET, {});
    expect(result.failure).toEqual({ failureKind: "timeout", mcpServerItemId: "server-1", timeoutMs: 60000 });
    expect(closeWithError).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { mcpServerItemId: "server-1" },
      "MCP connection close failed after tools/call",
    );
  });

  it("carries no failure when the run's signal aborted the call", async () => {
    const controller = new AbortController();
    controller.abort();
    mockHandle(vi.fn().mockRejectedValue(new McpError(ErrorCode.RequestTimeout, "x")), close);
    const result = await executeMcpInvocation(POOL, TARGET, {}, {}, controller.signal);
    expect(result).toEqual({ error: true, result: "MCP tool call was cancelled before it completed" });
  });

  it("classifies a connect timeout as timeout with the connection timeout", async () => {
    connectMcpServer.mockRejectedValue(new McpConnectionError("connect_timeout", "Timed out"));
    const result = await executeMcpInvocation(POOL, TARGET, {});
    expect(result.failure).toEqual({ failureKind: "timeout", mcpServerItemId: "server-1", timeoutMs: 15000 });
  });

  it("keeps connect timeout and address denial ahead of a conflicting HTTP status", async () => {
    connectMcpServer.mockRejectedValue(new McpConnectionError("connect_timeout", "slow", 403));
    expect((await executeMcpInvocation(POOL, TARGET, {})).failure).toEqual({
      failureKind: "timeout",
      mcpServerItemId: "server-1",
      timeoutMs: 15000,
    });
    connectMcpServer.mockRejectedValue(new McpConnectionError("address_not_allowed", "denied", 403));
    expect((await executeMcpInvocation(POOL, TARGET, {})).failure).toEqual({
      failureKind: "connection",
      mcpServerItemId: "server-1",
    });
  });

  it.each(["handshake_failed", "address_not_allowed", "transport_not_allowed", "stdio_sandbox_unavailable"] as const)(
    "classifies connection error %s as connection",
    async (reason) => {
      connectMcpServer.mockRejectedValue(new McpConnectionError(reason, "refused"));
      const result = await executeMcpInvocation(POOL, TARGET, {});
      expect(result.failure).toEqual({ failureKind: "connection", mcpServerItemId: "server-1" });
    },
  );

  it("classifies credential decryption failure and a 401 connect rejection as auth", async () => {
    connectMcpServer.mockRejectedValue(new McpConnectionError("credential_decryption_failed", "bad"));
    expect((await executeMcpInvocation(POOL, TARGET, {})).failure?.failureKind).toBe("auth");
    connectMcpServer.mockRejectedValue(new McpConnectionError("handshake_failed", "rejected", 401));
    expect((await executeMcpInvocation(POOL, TARGET, {})).failure?.failureKind).toBe("auth");
  });

  it("classifies a 403 on tools/call as auth", async () => {
    mockHandle(vi.fn().mockRejectedValue(new StreamableHTTPError(403, "forbidden")), close);
    expect((await executeMcpInvocation(POOL, TARGET, {})).failure).toEqual({
      failureKind: "auth",
      mcpServerItemId: "server-1",
    });
  });

  it("classifies a typed SDK authorization failure as auth without copying its message", async () => {
    mockHandle(vi.fn().mockRejectedValue(new UnauthorizedError("credential-sentinel")), close);
    const result = await executeMcpInvocation(POOL, TARGET, {});
    expect(result).toEqual({
      error: true,
      result: "MCP tool call failed for an unexpected reason",
      failure: { failureKind: "auth", mcpServerItemId: "server-1" },
    });
  });

  it("classifies an isError result and any other thrown error as toolError", async () => {
    mockHandle(vi.fn().mockResolvedValue({ isError: true, content: [{ type: "text", text: "nope" }] }), close);
    expect(await executeMcpInvocation(POOL, TARGET, {})).toEqual({
      error: true,
      result: "nope",
      failure: { failureKind: "toolError", mcpServerItemId: "server-1" },
    });
    mockHandle(vi.fn().mockRejectedValue(new Error("boom")), close);
    expect((await executeMcpInvocation(POOL, TARGET, {})).failure?.failureKind).toBe("toolError");
  });

  it("carries no failure for a successful call", async () => {
    mockHandle(vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }), close);
    expect(await executeMcpInvocation(POOL, TARGET, {})).toEqual({ error: false, result: "ok" });
  });

  it("handles the SDK compatibility result and rejects a malformed result without exposing it", async () => {
    mockHandle(vi.fn().mockResolvedValue({ toolResult: "legacy" }), close);
    expect(await executeMcpInvocation(POOL, TARGET, {})).toEqual({ error: false, result: "" });
    mockHandle(vi.fn().mockResolvedValue(null), close);
    expect(await executeMcpInvocation(POOL, TARGET, {})).toEqual({
      error: true,
      result: "MCP tool call failed for an unexpected reason",
      failure: { failureKind: "toolError", mcpServerItemId: "server-1" },
    });
  });
});

describe("executeMcpInvocation connection recording (issue #1450)", () => {
  const close = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    recordSuccess.mockReset().mockResolvedValue(undefined);
    recordFailure.mockReset().mockResolvedValue(undefined);
  });

  it("records a success after the connect", async () => {
    mockHandle(vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }), close);
    await executeMcpInvocation(POOL, TARGET, {});
    expect(recordSuccess).toHaveBeenCalledWith(POOL, "server-1");
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("records the reason of a connection error and no success", async () => {
    connectMcpServer.mockRejectedValue(new McpConnectionError("handshake_failed", "rejected"));
    await executeMcpInvocation(POOL, TARGET, {});
    expect(recordFailure).toHaveBeenCalledWith(POOL, "server-1", "handshake_failed");
    expect(recordSuccess).not.toHaveBeenCalled();
  });

  it("records a success, not a failure, when tools/call fails after a good connect", async () => {
    mockHandle(vi.fn().mockRejectedValue(new McpConnectionError("handshake_failed", "late")), close);
    await executeMcpInvocation(POOL, TARGET, {});
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("records nothing for a non-connection error thrown by the connect", async () => {
    connectMcpServer.mockRejectedValue(new Error("bug"));
    await executeMcpInvocation(POOL, TARGET, {});
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("returns the normal result when recording a success fails", async () => {
    recordSuccess.mockRejectedValue(new Error("db down"));
    mockHandle(vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }), close);
    expect(await executeMcpInvocation(POOL, TARGET, {})).toEqual({ error: false, result: "ok" });
  });

  it("returns the normal failure result when recording a failure fails", async () => {
    recordFailure.mockRejectedValue(new Error("db down"));
    connectMcpServer.mockRejectedValue(new McpConnectionError("connect_timeout", "slow"));
    expect(await executeMcpInvocation(POOL, TARGET, {})).toEqual({
      error: true,
      result: "slow",
      failure: { failureKind: "timeout", mcpServerItemId: "server-1", timeoutMs: 15000 },
    });
  });
});
