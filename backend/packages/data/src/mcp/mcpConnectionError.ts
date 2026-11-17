/**
 * `message` and `details` hold only fixed wording and non-secret identifiers, never the credential or an underlying
 * error's message, so the sync can store them without filtering.
 */
export const MCP_CONNECTION_ERROR_REASONS = [
  "invalid_config",
  // A stored `stdio` config whose tenant no longer allows it; refused before decryption or spawn.
  "transport_not_allowed",
  // No sandbox launcher socket outside tests; refused before decryption or spawn.
  "stdio_sandbox_unavailable",
  "credential_decryption_failed",
  // A stored URL failing the baseline at connect time (an older row), or a host resolving to a denied address.
  "address_not_allowed",
  // `Client.connect()` opens the transport and handshakes in one call, so the two failures cannot be told apart.
  "handshake_failed",
  // Told apart from `handshake_failed` by the factory's timeout marker, never by parsing a message.
  "connect_timeout",
] as const;

/** Default bound on `Client.connect()` (transport open plus `initialize` handshake). */
export const MCP_DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export type McpConnectionErrorReason = (typeof MCP_CONNECTION_ERROR_REASONS)[number];

export class McpConnectionError extends Error {
  readonly reason: McpConnectionErrorReason;
  /** A number only, never a message. */
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
