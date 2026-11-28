import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createLogger } from "@alldots/shared";
import type { Queryable } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";
import {
  createOutboundHttp,
  currentOutboundAddressPolicy,
  isOutboundAddressNotAllowed,
  type OutboundHttp,
} from "../net/outboundAddressPolicy.js";
import { assertValidMcpConnectionConfig, type McpConnectionConfig } from "./mcpConnectionConfig.js";
import {
  McpConnectionAuthenticationError,
  McpConnectionError,
  MCP_DEFAULT_CONNECT_TIMEOUT_MS,
} from "./mcpConnectionError.js";
import { SandboxedStdioClientTransport } from "./sandboxedStdioTransport.js";
import { tenantAllowsStdio } from "./stdioTransportPolicy.js";
import { createMcpHttpFailureObserver, type McpHttpObservation } from "./mcpHttpFailureObservation.js";

/**
 * The single MCP client connection factory, shared by tool sync and the outbound invoke adapter. Registers no
 * `tools/list_changed` handler, so such notifications have no effect anywhere.
 *
 * Callers must close the handle in `finally`. A failed connect already releases what it opened.
 */
export interface McpClientHandle {
  readonly client: Client;
  beginHttpObservation?(): McpHttpObservation;
  close(): Promise<void>;
}

export interface ConnectMcpServerOptions {
  actorId?: string;
  /** Defaults to `"mcp_connect"`. */
  purpose?: string;
  /** Mainly for tests. */
  connectTimeoutMs?: number;
}

const logger = createLogger("mcp");
const CLIENT_INFO = { name: "alldots-mcp-client", version: "1.0.0" };
/** `mcpClient.connect()` has no timeout of its own for a server that accepts but never answers `initialize`. */
const DEFAULT_CONNECT_TIMEOUT_MS = MCP_DEFAULT_CONNECT_TIMEOUT_MS;

/**
 * Decrypts the credential only for this connection. Before connecting, rejects with `McpConnectionError`: a bad
 * config, `stdio` the tenant no longer allows, `stdio` without a sandbox launcher outside tests, an `sse`/`http`
 * URL failing the stored-URL baseline (skipped under the test loopback policy), or a real decryption failure.
 * `sse`/`http` use the outbound address policy's `fetch`; failures map to `address_not_allowed`, `connect_timeout`
 * or `handshake_failed` after releasing the transport. A transient DB failure resolving the credential propagates
 * as-is.
 */
export async function connectMcpServer(
  client: Queryable,
  mcpServerItem: Pick<ItemRow, "id" | "properties">,
  options: ConnectMcpServerOptions = {},
): Promise<McpClientHandle> {
  const config = parseConnectionConfig(mcpServerItem.properties.connectionConfig);
  // The spawn is the security boundary: a row may hold `stdio` the write-time rule never checked (older row, or a
  // demoted tenant). Refused before decryption, so no `credential_access_log` row is written.
  if (config.transport === "stdio" && !(await tenantAllowsStdio(client))) {
    throw new McpConnectionError("transport_not_allowed", "MCP server transport is not allowed for this account");
  }
  const stdioLaunchSocket = config.transport === "stdio" ? resolveStdioLaunchSocket() : null;
  // Older rows may predate the write-time baseline, so it is re-checked before decryption.
  const policy = currentOutboundAddressPolicy();
  if (config.transport !== "stdio" && !policy.isTestPolicy && !isBaselineOutboundUrl(config.url)) {
    throw addressNotAllowed(config.transport);
  }
  const credential = await resolveCredential(client, mcpServerItem.id, options);
  const outbound = config.transport === "stdio" ? null : createOutboundHttp(policy);
  const refusal = { seen: false };
  const observer = config.transport === "sse" ? createMcpHttpFailureObserver(credential !== null) : undefined;
  const policyFetch = outbound === null ? undefined : recordAddressRefusal(outbound.fetch, refusal);
  const fetch = policyFetch && observer ? observer.wrapFetch(policyFetch) : policyFetch;
  const { transport, afterConnect } = buildTransport(config, credential, fetch, stdioLaunchSocket);
  observer?.install(transport);

  const mcpClient = new Client(CLIENT_INFO, { capabilities: {} });
  const observation = observer?.begin();
  try {
    const connect = () => mcpClient.connect(transport);
    await withTimeout(
      observation ? observation.run(connect) : connect(),
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
  } catch (err) {
    const observedStatus = observation?.status(err);
    observation?.close();
    await safeCloseTransport(transport);
    await safeCloseOutbound(outbound);
    if (refusal.seen) throw addressNotAllowed(config.transport);
    if (err instanceof ConnectTimeoutError) {
      throw new McpConnectionError(
        "connect_timeout",
        `Timed out connecting to MCP server (transport=${config.transport})`,
      );
    }
    if (err instanceof UnauthorizedError) {
      throw new McpConnectionAuthenticationError(`Failed to connect to MCP server (transport=${config.transport})`);
    }
    throw new McpConnectionError(
      "handshake_failed",
      `Failed to connect to MCP server (transport=${config.transport})`,
      authRejectionStatus(err) ?? observedStatus,
    );
  } finally {
    observation?.close();
  }
  // Scrubs any plain copy of the credential the transport kept, so `handle.client`'s serializable state never
  // carries it.
  afterConnect?.();

  return {
    client: mcpClient,
    ...(observer ? { beginHttpObservation: observer.begin } : {}),
    close: async () => {
      try {
        await mcpClient.close();
      } finally {
        await safeCloseOutbound(outbound);
      }
    },
  };
}

/**
 * Under the sandbox launcher socket when `ALLDOTS_MCP_LAUNCH_SOCKET` is set, in-process (`null`) only under
 * `NODE_ENV=test`, nowhere otherwise. Refused before decryption, so a host without the launcher never spawns a
 * server with this process's uid. See docs/architecture/delivery-and-operations.md#stdio-mcp-sandbox.
 */
function resolveStdioLaunchSocket(): string | null {
  const socketPath = process.env.ALLDOTS_MCP_LAUNCH_SOCKET;
  if (socketPath !== undefined && socketPath !== "") return socketPath;
  if (process.env.NODE_ENV === "test") return null;
  throw new McpConnectionError("stdio_sandbox_unavailable", "MCP stdio sandbox is not available on this host");
}

function addressNotAllowed(transport: McpConnectionConfig["transport"]): McpConnectionError {
  return new McpConnectionError("address_not_allowed", `MCP server address is not allowed (transport=${transport})`);
}

/**
 * Checked on what `fetch` threw rather than on `connect()`'s rejection, because the `sse` transport's
 * `EventSource` reduces a failed request to a message string and loses the cause chain.
 */
function recordAddressRefusal(fetch: FetchLike, refusal: { seen: boolean }): FetchLike {
  return async (input, init) => {
    try {
      return await fetch(input, init);
    } catch (err) {
      if (isOutboundAddressNotAllowed(err)) refusal.seen = true;
      throw err;
    }
  };
}

/**
 * A timeout leaves `promise` unsettled; the caller releases the resource. The `.catch(() => {})` only gives its
 * eventual rejection a handler: closing the transport after a timeout makes `connect()` reject with no listener,
 * which would crash the process as an unhandled rejection.
 */
class ConnectTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms`);
    this.name = "ConnectTimeoutError";
  }
}

/** The 401/403 status an HTTP transport reported for a rejected connect, or `undefined` for any other failure. */
function authRejectionStatus(err: unknown): number | undefined {
  if (!(err instanceof StreamableHTTPError || err instanceof SseError)) return undefined;
  return err.code === 401 || err.code === 403 ? err.code : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  promise.catch(() => {});
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConnectTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Closing the connection pools after an already-failed connect must not replace that failure. */
async function safeCloseOutbound(outbound: OutboundHttp | null): Promise<void> {
  if (outbound === null) return;
  try {
    await outbound.close();
  } catch (err) {
    logger.warn(
      { errorName: err instanceof Error ? err.name : typeof err },
      "MCP outbound connection pool close failed",
    );
  }
}

/** A failed connect can leave the transport partially open; `close()` on it must not itself throw over that. */
async function safeCloseTransport(transport: Transport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // best-effort cleanup after an already-failed connect; nothing further to report
  }
}

function parseConnectionConfig(value: unknown): McpConnectionConfig {
  try {
    return assertValidMcpConnectionConfig(value);
  } catch {
    throw new McpConnectionError("invalid_config", "MCP server has an invalid or unsupported connectionConfig");
  }
}

async function resolveCredential(
  client: Queryable,
  itemId: string,
  options: ConnectMcpServerOptions,
): Promise<string | null> {
  try {
    return await getDecryptedCredential(client, {
      itemId,
      actorType: "mcp_connection_manager",
      actorId: options.actorId,
      purpose: options.purpose ?? "mcp_connect",
    });
  } catch (err) {
    // A real decryption problem is reported as `McpConnectionError`; a transient DB failure is not a credential problem.
    // `pg` and node connection errors carry a string `.code`, `@alldots/credentials` errors never do.
    if (isLikelyDatabaseError(err)) throw err;
    throw new McpConnectionError(
      "credential_decryption_failed",
      "Failed to decrypt the MCP server's stored credential",
    );
  }
}

function isLikelyDatabaseError(err: unknown): boolean {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string";
}

interface BuiltTransport {
  readonly transport: Transport;
  /**
   * Safe only after a successful connect (see `buildStdioTransport`). A property, not a method: it is called
   * destructured, without `this`.
   */
  afterConnect?: () => void;
}

function buildTransport(
  config: McpConnectionConfig,
  credential: string | null,
  fetch: FetchLike | undefined,
  stdioLaunchSocket: string | null,
): BuiltTransport {
  switch (config.transport) {
    case "stdio":
      return stdioLaunchSocket === null
        ? buildStdioTransport(config, credential)
        : buildSandboxedStdioTransport(stdioLaunchSocket, config, credential);
    case "sse":
      return { transport: new SSEClientTransport(new URL(config.url), { ...authProviderOptions(credential), fetch }) };
    case "http":
      return {
        transport: new StreamableHTTPClientTransport(new URL(config.url), {
          ...authProviderOptions(credential),
          fetch,
        }),
      };
  }
}

function buildStdioTransport(
  config: Extract<McpConnectionConfig, { transport: "stdio" }>,
  credential: string | null,
): BuiltTransport {
  // The child env is the SDK's inherited allowlist (`getDefaultEnvironment()`), then the config's `env`, then the
  // credential. Passing it explicitly avoids relying on the SDK's default. The config schema refuses the inherited
  // names and loader/interpreter hooks.
  const credentialEnvVar = config.credentialEnvVar;
  const injectsCredential = credential !== null && credentialEnvVar !== undefined;
  const env: Record<string, string> = { ...getDefaultEnvironment(), ...config.env };
  if (injectsCredential) {
    env[credentialEnvVar] = credential;
  }
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env });
  // The transport only reads `env` synchronously while spawning, so the child already holds its copy; deleting the key
  // just removes it from the JS-side record reachable via `handle.client`.
  const afterConnect = injectsCredential ? () => delete env[credentialEnvVar] : undefined;
  return { transport, afterConnect };
}

/**
 * Launcher base env plus only the config's `env` and the credential, nothing from `process.env`. The transport
 * releases its header copy once `start()` settles and `env` is not kept, so no scrub is needed.
 */
function buildSandboxedStdioTransport(
  socketPath: string,
  config: Extract<McpConnectionConfig, { transport: "stdio" }>,
  credential: string | null,
): BuiltTransport {
  const env: Record<string, string> = { ...config.env };
  if (credential !== null && config.credentialEnvVar !== undefined) {
    env[config.credentialEnvVar] = credential;
  }
  return {
    transport: new SandboxedStdioClientTransport(socketPath, { command: config.command, args: config.args ?? [], env }),
  };
}

/**
 * The SDK calls `tokens()` on every request, so the credential lives only in this closure, never as a property
 * reachable from the client. The other methods only satisfy the interface; they run only on a 401/403 challenge,
 * which a pre-shared credential server never issues.
 */
function createBearerAuthProvider(credential: string): OAuthClientProvider {
  const tokens: OAuthTokens = { access_token: credential, token_type: "bearer" };
  const notSupported = (what: string) => () => {
    throw new Error(`MCP connection factory: ${what} is not supported for a stored bearer credential`);
  };
  return {
    get redirectUrl(): string | undefined {
      return undefined;
    },
    get clientMetadata(): OAuthClientMetadata {
      return { redirect_uris: [] };
    },
    clientInformation: () => undefined,
    tokens: () => tokens,
    saveTokens: () => {},
    redirectToAuthorization: notSupported("interactive OAuth authorization"),
    saveCodeVerifier: () => {},
    codeVerifier: notSupported("a PKCE code verifier"),
  };
}

/** `undefined` rather than an empty provider, so a credential-less server sees no `Authorization` header. */
function authProviderOptions(credential: string | null): { authProvider: OAuthClientProvider } | undefined {
  if (credential === null) return undefined;
  return { authProvider: createBearerAuthProvider(credential) };
}
