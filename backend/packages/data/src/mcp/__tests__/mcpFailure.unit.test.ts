import { describe, expect, it } from "vitest";
import { parseMcpInvokeFailure } from "../mcpFailure.js";

const SERVER_ID = "c53e092f-4b30-4d48-91df-753e260b84e8";

describe("MCP failure metadata", () => {
  it.each([
    { failureKind: "unavailable" },
    { failureKind: "unavailable", mcpServerItemId: SERVER_ID },
    { failureKind: "timeout", mcpServerItemId: SERVER_ID, timeoutMs: 60000 },
    { failureKind: "connection", mcpServerItemId: SERVER_ID },
    { failureKind: "auth", mcpServerItemId: SERVER_ID },
    { failureKind: "toolError", mcpServerItemId: SERVER_ID },
  ])("accepts $failureKind metadata", (value) => {
    expect(parseMcpInvokeFailure(value)).toEqual(value);
  });

  it.each([
    null,
    [],
    { failureKind: "other", mcpServerItemId: "server" },
    { failureKind: "connection" },
    { failureKind: "unavailable", mcpServerItemId: "" },
    { failureKind: "timeout", mcpServerItemId: "invalid-id", timeoutMs: 60000 },
    { failureKind: "timeout", mcpServerItemId: SERVER_ID },
    { failureKind: "timeout", mcpServerItemId: SERVER_ID, timeoutMs: 0 },
    { failureKind: "timeout", mcpServerItemId: SERVER_ID, timeoutMs: Infinity },
    { failureKind: "auth", mcpServerItemId: SERVER_ID, message: "secret sentinel" },
  ])("rejects malformed metadata without including its contents", (value) => {
    expect(() => parseMcpInvokeFailure(value)).toThrowError("Invalid MCP failure metadata");
  });
});
