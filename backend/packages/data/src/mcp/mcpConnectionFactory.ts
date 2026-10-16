import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createLogger } from "@semprec/shared";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Queryable } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { assertValidMcpConnectionConfig, type McpConnectionConfig } from "./mcpConnectionConfig.js";
import { McpConnectionError } from "./mcpConnectionError.js";
import { tenantAllowsStdio } from "./stdioTransportPolicy.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";
import {
  createOutboundHttp,
  currentOutboundAddressPolicy,
  isOutboundAddressNotAllowed,
  type OutboundHttp,
} from "../net/outboundAddressPolicy.js";

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

const logger = createLogger("mcp");
const CLIENT_INFO = { name: "semprec-mcp-client", version: "1.0.0" };
/** A misbehaving server can accept a TCP/SSE/HTTP connection or spawn cleanly and then never answer `initialize` — `mcpClient.connect()` has no timeout of its own for that, so this factory imposes one. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Connects to the MCP server described by `mcpServerItem.properties.connectionConfig`,
 * decrypting its `external_credentials` secret (if any) only for this connection's use.
 * Rejects a malformed/unsupported `connectionConfig`, a `stdio` config the tenant no longer allows
 * (`transport_not_allowed`, issue #1033), an `sse`/`http` URL that fails the stored-URL baseline
 * (`address_not_allowed`, issue #1034; skipped under the test-only loopback policy), or a genuine
 * credential decryption failure with `McpConnectionError` before opening any connection.
 * `sse`/`http` requests go through the current outbound address policy's `fetch`
 * (`net/outboundAddressPolicy.ts`): a host resolving to a denied address maps to
 * `address_not_allowed`, any other transport connect/handshake failure (including one that times
 * out — see `DEFAULT_CONNECT_TIMEOUT_MS`) to `handshake_failed`, both after releasing whatever the
 * transport had opened. A transient DB failure while resolving the credential propagates as-is
 * rather than being reported as a credential problem.
 */
export async function connectMcpServer(
  client: Queryable,
  mcpServerItem: Pick<ItemRow, "id" | "properties">,
  options: ConnectMcpServerOptions = {},
): Promise<McpClientHandle> {
  const config = parseConnectionConfig(mcpServerItem.properties.connectionConfig);
  // The spawn is the security boundary for `stdio`: a row can hold it without the write-time rule
  // having checked it (written before that rule, or its tenant's admin later demoted). Refuse before
  // the credential is decrypted, so no `credential_access_log` row is written for a refused spawn.
  if (config.transport === "stdio" && !(await tenantAllowsStdio(client))) {
    throw new McpConnectionError("transport_not_allowed", "MCP server transport is not allowed for this account");
  }
  // A row can hold a URL stored before the write-time baseline existed (issue #1029), so the
  // baseline is re-checked here, before the credential is decrypted.
  const policy = currentOutboundAddressPolicy();
  if (config.transport !== "stdio" && !policy.isTestPolicy && !isBaselineOutboundUrl(config.url)) {
    throw addressNotAllowed(config.transport);
  }
  const credential = await resolveCredential(client, mcpServerItem.id, options);
  const outbound = config.transport === "stdio" ? null : createOutboundHttp(policy);
  const refusal = { seen: false };
  const fetch = outbound === null ? undefined : recordAddressRefusal(outbound.fetch, refusal);
  const { transport, afterConnect } = buildTransport(config, credential, fetch);

  const mcpClient = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await withTimeout(mcpClient.connect(transport), options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  } catch {
    await safeCloseTransport(transport);
    await safeCloseOutbound(outbound);
    if (refusal.seen) throw addressNotAllowed(config.transport);
    throw new McpConnectionError("handshake_failed", `Failed to connect to MCP server (transport=${config.transport})`);
  }
  // The transport has already used the credential to spawn/authenticate; scrub any copy it kept
  // as a plain, JSON-serializable property so `handle.client`'s serializable state never carries it.
  afterConnect?.();

  return {
    client: mcpClient,
    close: async () => {
      try {
        await mcpClient.close();
      } finally {
        await safeCloseOutbound(outbound);
      }
    },
  };
}

function addressNotAllowed(transport: McpConnectionConfig["transport"]): McpConnectionError {
  return new McpConnectionError("address_not_allowed", `MCP server address is not allowed (transport=${transport})`);
}

/**
 * Notes when the policy refused a request: an `OutboundAddressNotAllowedError` anywhere in the
 * `cause` chain of an error the `fetch` threw. It is checked here rather than on the error
 * `connect()` rejects with, because the `sse` transport's `EventSource` reduces a failed request to
 * a message string before the SDK rejects, so the refusal is not in that error's chain.
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

function buildTransport(
  config: McpConnectionConfig,
  credential: string | null,
  fetch: FetchLike | undefined,
): BuiltTransport {
  switch (config.transport) {
    case "stdio":
      return buildStdioTransport(config, credential);
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
  // The child gets exactly the SDK's inherited allowlist (`getDefaultEnvironment()`: HOME, LOGNAME,
  // PATH, SHELL, TERM, USER, as present in this process), then the config's own `env`, then the
  // injected credential. Passing the object always makes that explicit rather than relying on the
  // SDK's handling of an omitted `env`. `mcpConnectionConfig`'s schema refuses the inherited names
  // and the loader and interpreter hooks listed there, so the config cannot override those.
  const credentialEnvVar = config.credentialEnvVar;
  const injectsCredential = credential !== null && credentialEnvVar !== undefined;
  const env: Record<string, string> = { ...getDefaultEnvironment(), ...config.env };
  if (injectsCredential) {
    env[credentialEnvVar] = credential;
  }
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env });
  // `StdioClientTransport` retains this exact `env` object as `_serverParams.env`, but it only
  // *reads* from it synchronously while spawning the child (inside `connect()`, above) — the
  // spawned process already has its own copy of the credential in its real environment by the
  // time `connect()` resolves. Deleting the key here afterward only removes it from this
  // JS-side record, so it can no longer be found by inspecting `handle.client`.
  const afterConnect = injectsCredential ? () => delete env[credentialEnvVar] : undefined;
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
