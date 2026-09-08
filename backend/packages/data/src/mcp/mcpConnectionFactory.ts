import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Queryable } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { assertValidMcpConnectionConfig, type McpConnectionConfig } from "./mcpConnectionConfig.js";
import { McpConnectionError } from "./mcpConnectionError.js";

/**
 * The single MCP client connection factory (issue #231): opens a connection for a stored
 * `mcpServers` item's `stdio`/`sse`/`http` `connectionConfig`, completes the `initialize`
 * handshake, and hands back a connected client plus an explicit `close()`. Both the
 * human-triggered "Synchronize tools" action (#125, `tools/list`) and the outbound MCP-invoke
 * adapter in `semprec-agents` (#128, `tools/call`) import this rather than re-implementing
 * transport handling — see the issue's Task section.
 *
 * Registers no handler for `notifications/tools/list_changed` (no `listChanged` option is
 * passed to `Client`'s constructor) — a server that emits it has no observable effect here or
 * anywhere downstream, per the issue's "structural non-reactivity" acceptance criterion.
 *
 * Callers must use try/finally: `const handle = await connectMcpServer(...); try { ... }
 * finally { await handle.close(); }`. A failed connect/handshake already releases whatever
 * transport it opened before rethrowing, but a successful connect's cleanup is the caller's
 * responsibility once it's done with the client.
 */
export interface McpClientHandle {
  readonly client: Client;
  close(): Promise<void>;
}

export interface ConnectMcpServerOptions {
  /** Forwarded to `credential_access_log.actor_id` (see `getDecryptedCredential`). */
  actorId?: string;
  /** Forwarded to `credential_access_log.purpose`. Defaults to `"mcp_connect"`. */
  purpose?: string;
  /** Overrides how long to wait for the transport to open and the `initialize` handshake to complete (default 15s, mainly for tests). */
  connectTimeoutMs?: number;
}

const CLIENT_INFO = { name: "semprec-mcp-client", version: "1.0.0" };
/** A misbehaving server can accept a TCP/SSE/HTTP connection or spawn cleanly and then never answer `initialize` — `mcpClient.connect()` has no timeout of its own for that, so this factory imposes one. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Connects to the MCP server described by `mcpServerItem.properties.connectionConfig`,
 * decrypting its `external_credentials` secret (if any) only for this connection's use.
 * Rejects a malformed/unsupported `connectionConfig` or a genuine credential decryption failure
 * with `McpConnectionError` before opening any connection; maps a transport connect/handshake
 * failure (including one that times out — see `DEFAULT_CONNECT_TIMEOUT_MS`) to the same safe
 * error shape after releasing whatever the transport had opened. A transient DB failure while
 * resolving the credential propagates as-is rather than being reported as a credential problem.
 */
export async function connectMcpServer(
  client: Queryable,
  mcpServerItem: Pick<ItemRow, "id" | "properties">,
  options: ConnectMcpServerOptions = {},
): Promise<McpClientHandle> {
  const config = parseConnectionConfig(mcpServerItem.properties.connectionConfig);
  const credential = await resolveCredential(client, mcpServerItem.id, options);
  const { transport, afterConnect } = buildTransport(config, credential);

  const mcpClient = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await withTimeout(mcpClient.connect(transport), options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  } catch {
    await safeCloseTransport(transport);
    throw new McpConnectionError("handshake_failed", `Failed to connect to MCP server (transport=${config.transport})`);
  }
  // The transport has already used the credential to spawn/authenticate; scrub any copy it kept
  // as a plain, JSON-serializable property so `handle.client`'s serializable state never carries it.
  afterConnect?.();

  return {
    client: mcpClient,
    close: () => mcpClient.close(),
  };
}

/**
 * Races `promise` against a timer; a timeout leaves `promise` itself unsettled (its eventual
 * result is just never awaited) — the caller is responsible for releasing whatever resource it
 * was opening. `promise.catch(() => {})` below is not the value raced against — it exists only
 * to give `promise`'s eventual rejection a handler, since closing the transport after a timeout
 * (the caller's very next step) makes the original `connect()` reject with nothing else
 * listening, which without this would crash the process as an unhandled rejection.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  promise.catch(() => {});
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
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
    // `getDecryptedCredential` can fail for two unrelated reasons: the ciphertext/master key is
    // genuinely bad (a real credential problem, safe to report via `McpConnectionError`), or one
    // of its own `client.query` calls hit a transient DB failure (a connectivity/pool problem
    // that has nothing to do with this credential and shouldn't be misreported as one). `pg`
    // (and node's own connection errors) attach a string `.code`; the master-key/decrypt errors
    // thrown by `@semprec/credentials` never do — so that's the signal used to tell them apart.
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
   * Runs once `mcpClient.connect(transport)` has succeeded, to scrub any plain, JSON-serializable
   * copy of the credential the transport kept for itself — see `buildStdioTransport`'s comment
   * for why this is safe to do only *after* a successful connect.
   *
   * A property rather than a method: `connectMcpServer` destructures it off the result and
   * calls it standalone, so it must never depend on a `this` binding.
   */
  afterConnect?: () => void;
}

function buildTransport(config: McpConnectionConfig, credential: string | null): BuiltTransport {
  switch (config.transport) {
    case "stdio":
      return buildStdioTransport(config, credential);
    case "sse":
      return { transport: new SSEClientTransport(new URL(config.url), authProviderOptions(credential)) };
    case "http":
      return { transport: new StreamableHTTPClientTransport(new URL(config.url), authProviderOptions(credential)) };
  }
}

function buildStdioTransport(
  config: Extract<McpConnectionConfig, { transport: "stdio" }>,
  credential: string | null,
): BuiltTransport {
  // `env: undefined` (not `{}`) when there's nothing to add — `StdioClientTransport` falls back
  // to `getDefaultEnvironment()`'s safe allowlist only when `env` is omitted entirely; passing
  // any other object (even one that only adds the injected credential) silently strips that
  // default environment from the child process. So once we know we need a non-undefined `env`
  // for any reason, we must seed it from `getDefaultEnvironment()` ourselves.
  const credentialEnvVar = config.credentialEnvVar;
  const injectsCredential = credential !== null && credentialEnvVar !== undefined;
  let env: Record<string, string> | undefined;
  if (config.env || injectsCredential) {
    env = { ...getDefaultEnvironment(), ...config.env };
    if (injectsCredential) {
      env[credentialEnvVar] = credential;
    }
  }
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env });
  // `StdioClientTransport` retains this exact `env` object as `_serverParams.env`, but it only
  // *reads* from it synchronously while spawning the child (inside `connect()`, above) — the
  // spawned process already has its own copy of the credential in its real environment by the
  // time `connect()` resolves. Deleting the key here afterward only removes it from this
  // JS-side record, so it can no longer be found by inspecting `handle.client`.
  const afterConnect = injectsCredential ? () => delete env![credentialEnvVar] : undefined;
  return { transport, afterConnect };
}

/**
 * Bearer-token `OAuthClientProvider` for a stored non-interactive credential (issue #231's
 * sse/http case): the SDK's transports call `tokens()` fresh on every request rather than
 * reading `Authorization` off a stored `requestInit`, so the credential only ever lives inside
 * this closure — never as a plain property of the transport, the provider, or anything else
 * reachable from the returned client. The other `OAuthClientProvider` methods exist only to
 * satisfy the interface: none of them run unless the server challenges with 401/403, which a
 * server authenticating a pre-shared credential this way never does.
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

/** `undefined` (not a provider with no tokens) when there's no credential, so a credential-less server sees no `Authorization` header at all. */
function authProviderOptions(credential: string | null): { authProvider: OAuthClientProvider } | undefined {
  if (credential === null) return undefined;
  return { authProvider: createBearerAuthProvider(credential) };
}
