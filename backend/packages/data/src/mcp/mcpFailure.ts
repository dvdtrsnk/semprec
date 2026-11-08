export const MCP_FAILURE_KINDS = ["timeout", "unavailable", "connection", "auth", "toolError"] as const;
export type McpFailureKind = (typeof MCP_FAILURE_KINDS)[number];
export type McpInvokeFailure =
  | { failureKind: "unavailable"; mcpServerItemId?: string }
  | { failureKind: "timeout"; mcpServerItemId: string; timeoutMs: number }
  | { failureKind: "connection" | "auth" | "toolError"; mcpServerItemId: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMcpItemId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Validates persisted and incoming failure metadata without including its contents in errors. */
export function parseMcpInvokeFailure(value: unknown): McpInvokeFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid MCP failure metadata");
  if (!("failureKind" in value)) throw new Error("Invalid MCP failure metadata");
  const keys = Object.keys(value);
  const server = "mcpServerItemId" in value ? value.mcpServerItemId : undefined;
  const validServer = isMcpItemId(server);
  if (value.failureKind === "unavailable" && keys.every((key) => key === "failureKind" || key === "mcpServerItemId")) {
    if (server === undefined) return { failureKind: "unavailable" };
    if (validServer) return { failureKind: "unavailable", mcpServerItemId: server };
  }
  if (
    value.failureKind === "timeout" &&
    validServer &&
    keys.every((key) => ["failureKind", "mcpServerItemId", "timeoutMs"].includes(key))
  ) {
    const timeout = "timeoutMs" in value ? value.timeoutMs : undefined;
    if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)
      return { failureKind: "timeout", mcpServerItemId: server, timeoutMs: timeout };
  }
  if (
    (value.failureKind === "connection" || value.failureKind === "auth" || value.failureKind === "toolError") &&
    validServer &&
    keys.every((key) => key === "failureKind" || key === "mcpServerItemId")
  ) {
    return { failureKind: value.failureKind, mcpServerItemId: server };
  }
  throw new Error("Invalid MCP failure metadata");
}
