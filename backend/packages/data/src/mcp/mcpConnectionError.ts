/**
 * Safe, typed error the connection factory (mcpConnectionFactory.ts, issue #231) raises for
 * every failure mode it can hit — a malformed/unsupported `connectionConfig`, a credential
 * decryption failure, a refused outbound address, a missing stdio sandbox, or a transport connect/handshake failure.
 * `message` and `details` are built from the error's own fixed wording plus non-secret identifiers (a transport name, an
 * item id) only, never from the plaintext credential or from an underlying error's message
 * (which could itself echo back request state) — that's what lets the sync action (#125)
 * record `reason` directly as the server's `syncStatus`/error field without further filtering.
 */
export const MCP_CONNECTION_ERROR_REASONS = [
  "invalid_config",
  // A stored `stdio` config whose tenant no longer confines `stdio` to an admin (issue #1033): refused
  // at spawn before any credential is decrypted or any child process starts.
  "transport_not_allowed",
  // A `stdio` config in a process that has no sandbox launcher socket (`SEMPREC_MCP_LAUNCH_SOCKET`)
  // and is not under test (issue #1070): refused before any credential is decrypted or process starts.
  "stdio_sandbox_unavailable",
  "credential_decryption_failed",
  // A stored `sse`/`http` URL that fails the stored-URL baseline at connect time (a row written
  // before that rule), or whose host resolves to an address the outbound policy denies (issue #1034).
  "address_not_allowed",
  // `Client.connect()` opens the transport and completes the `initialize` handshake as one call,
  // so the SDK gives this factory no way to tell a transport-open failure apart from a handshake
  // failure — both map to this single reason.
  "handshake_failed",
  // The handshake did not finish within the connect timeout (issue #1444); told apart from
  // `handshake_failed` by the timeout marker the factory raises, never by parsing a message.
  "connect_timeout",
] as const;

/** Default bound on `Client.connect()` (transport open plus `initialize` handshake). */
export const MCP_DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export type McpConnectionErrorReason = (typeof MCP_CONNECTION_ERROR_REASONS)[number];

export class McpConnectionError extends Error {
  readonly reason: McpConnectionErrorReason;
  /** The 401/403 status the server rejected the connect with, when the transport reported one (issue #1444); a number only, never a message. */
  readonly httpStatus?: number;

  constructor(reason: McpConnectionErrorReason, message: string, httpStatus?: number) {
    super(message);
    this.name = "McpConnectionError";
    this.reason = reason;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

/** A typed SDK authorization failure during the handshake, without an invented HTTP status. */
export class McpConnectionAuthenticationError extends McpConnectionError {
  constructor(message: string) {
    super("handshake_failed", message);
  }
}
