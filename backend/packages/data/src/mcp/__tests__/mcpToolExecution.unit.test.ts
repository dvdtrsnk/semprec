import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const connectMcpServer = vi.fn();
vi.mock("../mcpConnectionFactory.js", () => ({ connectMcpServer: (...args: unknown[]) => connectMcpServer(...args) }));

const { executeMcpInvocation } = await import("../mcpToolExecution.js");
const { McpConnectionError } = await import("../mcpConnectionError.js");
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

const POOL = {} as Pool;
const TARGET = { serverItem: { id: "server-1", properties: {} }, toolName: "search_web" };

function mockHandle(callTool: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>) {
  connectMcpServer.mockResolvedValue({ client: { callTool }, close });
}

describe("executeMcpInvocation (issue #693)", () => {
  it("resolves the tool's result even when close() rejects afterward", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const close = vi.fn().mockRejectedValue(new Error("close boom"));
    mockHandle(callTool, close);

    const result = await executeMcpInvocation(POOL, TARGET, {});

    expect(result).toEqual({ error: false, result: "ok" });
    expect(close).toHaveBeenCalled();
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
});
