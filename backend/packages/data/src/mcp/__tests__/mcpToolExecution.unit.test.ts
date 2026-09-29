import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const connectMcpServer = vi.fn();
vi.mock("../mcpConnectionFactory.js", () => ({ connectMcpServer: (...args: unknown[]) => connectMcpServer(...args) }));

const { executeMcpInvocation } = await import("../mcpToolExecution.js");

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

    expect(result).toEqual({ error: true, result: "MCP tool call failed for an unexpected reason" });
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
