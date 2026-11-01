import { describe, expect, it } from "vitest";
import { parseMcpInvokeFailure } from "../mcpFailure.js";

describe("MCP failure metadata", () => {
  it.each([
    { failureKind: "unavailable" },
    { failureKind: "unavailable", mcpServerItemId: "server" },
    { failureKind: "timeout", mcpServerItemId: "server", timeoutMs: 60000 },
    { failureKind: "connection", mcpServerItemId: "server" },
    { failureKind: "auth", mcpServerItemId: "server" },
    { failureKind: "toolError", mcpServerItemId: "server" },
  ])("accepts $failureKind metadata", (value) => {
    expect(parseMcpInvokeFailure(value)).toEqual(value);
  });

  it.each([
    null,
    [],
    { failureKind: "other", mcpServerItemId: "server" },
    { failureKind: "connection" },
    { failureKind: "unavailable", mcpServerItemId: "" },
    { failureKind: "timeout", mcpServerItemId: "server" },
    { failureKind: "timeout", mcpServerItemId: "server", timeoutMs: 0 },
    { failureKind: "timeout", mcpServerItemId: "server", timeoutMs: Infinity },
    { failureKind: "auth", mcpServerItemId: "server", message: "secret sentinel" },
  ])("rejects malformed metadata without including its contents", (value) => {
    expect(() => parseMcpInvokeFailure(value)).toThrowError("Invalid MCP failure metadata");
  });
});
