import { connect, isIP, Socket, type LookupFunction } from "node:net";
import { TLSSocket } from "node:tls";
import { ImapFlow } from "imapflow";
import { createTransport, type SendMailOptions } from "nodemailer";
import {
  OutboundAddressNotAllowedError,
  createPolicyLookup,
  currentOutboundAddressPolicy,
  isOutboundAddressNotAllowed,
  type OutboundAddressPolicy,
} from "../net/outboundAddressPolicy.js";
import { ImapFlowMailClient } from "./imapFlowClient.js";
import { logger } from "./logger.js";
import type { MailServerEndpoint } from "./mailServerSettingsStore.js";
import { MailServerUnreachableError } from "./providerTypes.js";

/**
 * Connections to tenant-chosen IMAP and SMTP hosts (docs/adr/2026-10-29-mail-connections-through-the-outbound-address-policy.md).
 * Both factories resolve the host name once through the outbound address policy and connect only to
 * the address that resolved, while the TLS server name stays the host name. A refused or unreachable
 * server surfaces as MailServerUnreachableError; an authentication failure stays what the library
 * reports.
 */

/** One IMAP or SMTP endpoint of a mailbox, and the account name that logs in to it. */
export interface MailServerConnectionSettings {
  endpoint: MailServerEndpoint;
  username: string;
}

/** The app-specific password the mailbox logs in with. Tenant-chosen hosts take no OAuth token: the settings store holds none. */
export interface MailServerCredential {
  readonly password: string;
}

export interface MailServerConnectionOptions {
  /** Vets every address the host name resolves to. Defaults to the module policy (`currentOutboundAddressPolicy`). */
  policy?: OutboundAddressPolicy;
  /**
   * IMAP only; `createSmtpTransporter` ignores it. imapflow reads it when the client is constructed, so a caller
   * that receives a connected client cannot set it. Forwarded to the `ImapFlow` constructor when present; imapflow's
   * default applies otherwise (docs/adr/2026-10-29-imap-idle-connections-through-the-shared-imap-connect-step.md).
   */
  maxIdleTime?: number;
  /** IMAP only, as `maxIdleTime`: how long the socket may stay silent before imapflow gives up on it. */
  socketTimeout?: number;
}

/** A connection attempt may not take longer than this to establish, in each library and for the TCP connect of SMTP. */
const CONNECT_TIMEOUT_MS = 30_000;
/** How long the server may take to send its greeting, passed to both libraries. */
const GREETING_TIMEOUT_MS = 15_000;

/**
 * Failures of the connect path: the socket never came up, dropped, or a library's connect step timed out.
 * nodemailer reports every socket-level failure, a TLS handshake failure included, as `ESOCKET` or
 * `ECONNECTION`, and its `_formatError` overwrites the error's own code with that one; so these two codes
 * stand for the whole socket-and-TLS path of SMTP, and the TLS code of the cause is not available there.
 */
const CONNECT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPROTO",
  "ESOCKET",
  "ECONNECTION",
  // Timeouts raised by imapflow's own connect steps (connection-deadline.js and imap-flow.js).
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
]);

/** TLS failures: a handshake or certificate check that did not pass, including nodemailer's `ETLS` wrapper. */
const TLS_FAILURE_CODES: ReadonlySet<string> = new Set([
  "ETLS",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** An own property of an error or other object; the errors this module reads set their fields as own properties. */
function propertyOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function codeOf(value: unknown): string | undefined {
  const code = propertyOf(value, "code");
  return typeof code === "string" ? code : undefined;
}

/** The error and every error in its `cause` chain, outermost first, each object once. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !chain.includes(current)) {
    chain.push(current);
    current = propertyOf(current, "cause");
  }
  return chain;
}

function isAuthenticationFailure(error: unknown): boolean {
  return errorChain(error).some(
    (link) => propertyOf(link, "authenticationFailed") === true || codeOf(link) === "EAUTH",
  );
}

function isConnectionFailure(error: unknown): boolean {
  if (isOutboundAddressNotAllowed(error)) return true;
  return errorChain(error).some((link) => {
    const code = codeOf(link);
    return (
      propertyOf(link, "tlsFailed") === true ||
      (code !== undefined && (CONNECT_FAILURE_CODES.has(code) || TLS_FAILURE_CODES.has(code)))
    );
  });
}

/**
 * Maps a connect, refusal or TLS failure to MailServerUnreachableError and returns every other error
 * unchanged. The mapped error has no cause and names no address, so a refused address cannot be told
 * apart from an unreachable server. Diagnostics carry only a fixed stage.
 */
function mapConnectionFailure(error: unknown): unknown {
  if (isAuthenticationFailure(error) || !isConnectionFailure(error)) return error;
  const observed: unknown[] = [error];
  connectionDiagnostic("connect", observed);
  return new MailServerUnreachableError();
}

function connectionDiagnostic(stage: "connect" | "connect_close" | "connect_event", observed: unknown[]): void {
  try {
    logger.warn({ stage }, "Mail connection reported a failure");
  } catch (error) {
    observed.push(error);
    // A diagnostic failure cannot replace the owned connection outcome.
  }
}

function policyOf(options: MailServerConnectionOptions): OutboundAddressPolicy {
  return options.policy ?? currentOutboundAddressPolicy();
}

/**
 * The policy lookup never runs for an IP-literal host, so a literal is vetted here, before any socket is
 * opened: it is refused unless the policy allows literals, and the default policy allows none. The stored-host
 * contract already refuses literals at write time; this is the connect-time backstop.
 */
function literalRefusal(host: string, policy: OutboundAddressPolicy): OutboundAddressNotAllowedError | undefined {
  return isIP(host) !== 0 && !policy.allowsIpLiteral(host) ? new OutboundAddressNotAllowedError(host) : undefined;
}

function closeAfterFailedConnect(client: ImapFlow): void {
  try {
    client.close();
  } catch (error) {
    // The connect failure is the error the caller needs; a failed close is logged and not rethrown.
    const observed: unknown[] = [error];
    connectionDiagnostic("connect_close", observed);
  }
}

function buildImapFlow(
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  options: MailServerConnectionOptions,
  policy: OutboundAddressPolicy,
  connectionTimeout: number,
  verification = false,
  testCa?: string,
  testPort?: number,
): ImapFlow {
  const { endpoint, username } = settings;
  return new ImapFlow({
    host: endpoint.host,
    port: testPort ?? endpoint.port,
    secure: endpoint.security === "tls",
    ...(endpoint.security === "starttls" ? { doSTARTTLS: true } : {}),
    auth: { user: username, pass: credential.password },
    tls: { servername: endpoint.host, lookup: createPolicyLookup(policy), ...(testCa ? { ca: testCa } : {}) },
    connectionTimeout,
    greetingTimeout: GREETING_TIMEOUT_MS,
    ...(verification ? { disableCompression: true } : {}),
    ...(options.maxIdleTime !== undefined ? { maxIdleTime: options.maxIdleTime } : {}),
    ...(options.socketTimeout !== undefined ? { socketTimeout: options.socketTimeout } : {}),
    // ImapFlow's protocol logger can emit user content.
    logger: false,
  });
}

type VerificationAttempt = "success" | "authentication" | "tls" | "unreachable";

export interface VerificationTestOptions {
  deadlineMs?: number;
  ca?: string;
  ports?: Readonly<Record<number, number>>;
}

/** ImapFlow 1.7.6 sets an own `socket` during connect and replaces it for STARTTLS. */
function verificationImapSocket(client: ImapFlow): Socket {
  const value: unknown = Object.getOwnPropertyDescriptor(client, "socket")?.value;
  if (!(value instanceof Socket)) throw new Error("IMAP verification could not observe its owned socket");
  return value;
}

/** Verifies a single IMAP endpoint without returning the library client. */
export async function verifyImapServerConnection(
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  options: MailServerConnectionOptions = {},
  testOptions?: VerificationTestOptions,
): Promise<VerificationAttempt> {
  if (testOptions && process.env.NODE_ENV !== "test") throw new Error("Verification test options require test mode");
  const policy = policyOf(options);
  if (literalRefusal(settings.endpoint.host, policy)) return "unreachable";
  const client = buildImapFlow(
    settings,
    credential,
    options,
    policy,
    CONNECT_TIMEOUT_MS,
    true,
    testOptions?.ca,
    testOptions?.ports?.[settings.endpoint.port],
  );
  const observations: Array<{ source: "client" | "socket"; value: unknown; beforeOwner: boolean }> = [];
  let ownerAction = false;
  const observe = (source: "client" | "socket", value: unknown) =>
    observations.push({ source, value, beforeOwner: !ownerAction });
  const clientError = (error: unknown) => observe("client", error);
  client.on("error", clientError);
  const observed = new Map<Socket, { closed: Promise<void>; listener: (error: Error) => void }>();
  let initialSocket: Socket | undefined;
  let alreadyClosedWrapper: TLSSocket | undefined;
  const capture = (): Socket => {
    const socket = verificationImapSocket(client);
    if (!observed.has(socket)) {
      if (socket.closed) {
        // ImapFlow 1.7.6 wraps this attempt's original TCP socket for STARTTLS, without a second dial.
        // Its actual close event is still required below; `closed` alone is not transport proof.
        if (settings.endpoint.security !== "starttls" || !initialSocket || !(socket instanceof TLSSocket)) {
          throw new Error("IMAP verification missed the owned socket close event");
        }
        alreadyClosedWrapper = socket;
        return socket;
      }
      initialSocket ??= socket;
      const listener = (error: Error) => observe("socket", error);
      socket.on("error", listener);
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));
      observed.set(socket, { closed, listener });
    }
    return socket;
  };
  const ownerCancellation = new Error("IMAP verification attempt expired");
  let expired = false;
  let cancellationFailure: { error: unknown } | undefined;
  const deadline = setTimeout(() => {
    expired = true;
    try {
      const socket = capture();
      ownerAction = true;
      socket.destroy(ownerCancellation);
    } catch (error) {
      cancellationFailure = { error };
    }
  }, testOptions?.deadlineMs ?? 15_000);
  const operation = client.connect().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let initialFailure: { error: unknown } | undefined;
  try {
    capture();
  } catch (error) {
    initialFailure = { error };
  }
  const result = await operation;
  clearTimeout(deadline);
  const failures: unknown[] = [];
  if (initialFailure) failures.push(initialFailure.error);
  if (cancellationFailure) failures.push(cancellationFailure.error);
  try {
    capture();
  } catch (error) {
    failures.push(error);
  }
  if (!result.ok && result.error === ownerCancellation) {
    await Promise.all([...observed.values()].map((entry) => entry.closed));
  }
  try {
    client.close();
  } catch (error) {
    failures.push(error);
    for (const socket of observed.keys()) {
      try {
        if (!socket.destroyed) socket.destroy();
      } catch (destroyError) {
        failures.push(destroyError);
      }
    }
  }
  await Promise.all([...observed.values()].map((entry) => entry.closed));
  if (alreadyClosedWrapper && !alreadyClosedWrapper.closed) {
    failures.push(new Error("IMAP verification TLS wrapper did not reach terminal state"));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  client.removeListener("error", clientError);
  for (const [socket, entry] of observed) {
    socket.removeListener("error", entry.listener);
  }
  const secondary = observations.filter(
    (entry) => entry.value !== ownerCancellation && (result.ok || entry.value !== result.error),
  );
  const prior = secondary.filter((entry) => entry.beforeOwner);
  failures.push(...prior.map((entry) => entry.value));
  if (failures.length) {
    const distinct = [...new Set(result.ok ? failures : [result.error, ...failures])];
    if (distinct.length === 1) throw distinct[0];
    throw new AggregateError(distinct, "IMAP verification had multiple failures");
  }
  if (!result.ok && result.error === ownerCancellation) {
    const later = secondary.filter((entry) => !entry.beforeOwner);
    if (later.length) {
      try {
        if (!logger.isLevelEnabled("error")) throw new Error("IMAP verification diagnostic is disabled");
        logger.error(
          {
            count: later.length,
            observations: later.map((entry, index) => ({
              order: index + 1,
              source: entry.source,
              category: entry.value instanceof Error ? "error" : "non_error",
            })),
          },
          "IMAP verification observed secondary failures after cancellation",
        );
      } catch (diagnosticError) {
        // The ordered members retain the primary, observations, and diagnostic failure.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError(
          [result.error, ...later.map((entry) => entry.value), diagnosticError],
          "IMAP verification diagnostic could not be emitted",
        );
      }
    }
    return "unreachable";
  }
  if (secondary.length) {
    const distinct = [
      ...new Set(
        result.ok ? secondary.map((entry) => entry.value) : [result.error, ...secondary.map((entry) => entry.value)],
      ),
    ];
    if (distinct.length === 1) throw distinct[0];
    throw new AggregateError(distinct, "IMAP verification had multiple failures");
  }
  if (result.ok) {
    if (expired) throw new Error("IMAP verification completed after its deadline");
    return "success";
  }
  if (ownerAction) throw result.error;
  if (isAuthenticationFailure(result.error)) return "authentication";
  if (isOutboundAddressNotAllowed(result.error)) return "unreachable";
  if (
    errorChain(result.error).some(
      (error) => propertyOf(error, "tlsFailed") === true || TLS_FAILURE_CODES.has(codeOf(error) ?? ""),
    )
  )
    return "tls";
  if (isConnectionFailure(result.error)) return "unreachable";
  throw result.error;
}

/**
 * The connect step of every IMAP connection to a tenant-chosen host
 * (docs/adr/2026-10-29-imap-idle-connections-through-the-shared-imap-connect-step.md). imapflow hands its TLS
 * options to `tls.connect`, so the policy lookup resolves the host name once and the socket connects to the
 * vetted address; `servername` keeps the host name for SNI and certificate checks. Resolves with the connected
 * client and never with an unconnected one. A refused, unreachable or TLS-failing server rejects with
 * MailServerUnreachableError; a rejected login rejects with imapflow's authentication error.
 */
export async function openImapFlow(
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  options: MailServerConnectionOptions = {},
): Promise<ImapFlow> {
  const { endpoint } = settings;
  const policy = policyOf(options);
  const refusal = literalRefusal(endpoint.host, policy);
  if (refusal !== undefined) throw mapConnectionFailure(refusal);
  const client = buildImapFlow(settings, credential, options, policy, CONNECT_TIMEOUT_MS);
  // imapflow throws from its event emitter when an error has no listener, and it can emit after connect() settles.
  client.on("error", (error: unknown) => {
    const observed: unknown[] = [error];
    connectionDiagnostic("connect_event", observed);
  });
  try {
    await client.connect();
  } catch (error) {
    closeAfterFailedConnect(client);
    throw mapConnectionFailure(error);
  }
  return client;
}

/**
 * Opens an IMAP connection for the sync pass: the connected client of `openImapFlow`, wrapped in the narrow
 * `ImapFlowMailClient` the reconcile pass uses (imapFlowClient.ts). The wrapper keeps the raw client private.
 */
export async function openImapConnection(
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  options: MailServerConnectionOptions = {},
): Promise<ImapFlowMailClient> {
  return new ImapFlowMailClient(await openImapFlow(settings, credential, options));
}

/** The SMTP operations the rest of the package uses. Its connect and send failures map exactly as `openImapConnection`'s do. */
export interface MailSmtpTransporter {
  /** Connects, negotiates TLS, logs in and disconnects; resolves `true` when the server accepts the login. */
  verify(): Promise<true>;
  /**
   * Resolves when the server accepts the message, with the number of recipients it refused. A refused
   * recipient is not an error here: the server may still have accepted the message for the others.
   */
  sendMail(message: SendMailOptions): Promise<{ refusedRecipientCount: number }>;
  /** Ends the transport. A send still in flight ends too: every socket it holds is destroyed, and the send rejects. */
  close(): void;
}

/**
 * nodemailer's `getSocket` hook. It opens the TCP socket with the policy lookup and hands it over once
 * connected. nodemailer then runs TLS (`secure`) or STARTTLS (`requireTLS`) on that socket with the
 * host name as the server name. nodemailer's own resolver is not reached on this path, so the name is
 * resolved only by the policy.
 */
type SocketCallback = (error: Error | null, socketOptions?: { connection: Socket }) => void;

function connectPinned(
  host: string,
  port: number,
  lookup: LookupFunction,
  callback: SocketCallback,
  openSockets: Set<Socket>,
  onSocket?: (socket: Socket) => void,
): void {
  const socket = connect({ host, port, lookup });
  openSockets.add(socket);
  try {
    onSocket?.(socket);
  } catch (error) {
    openSockets.delete(socket);
    try {
      socket.destroy();
    } catch (cleanupError) {
      // The aggregate retains both values; its cause remains the primary setup failure.
      // eslint-disable-next-line preserve-caught-error
      throw new AggregateError([error, cleanupError], "SMTP socket setup and cleanup failed", { cause: error });
    }
    throw error;
  }
  let connected = false;
  let settled = false;
  // The socket reports an error and then closes, so the callback is settled once, by whichever comes first.
  const settle: SocketCallback = (error, socketOptions) => {
    if (settled) return;
    settled = true;
    callback(error, socketOptions);
  };
  const timer = setTimeout(() => {
    socket.destroy(Object.assign(new Error("Connection attempt timed out"), { code: "ETIMEDOUT" }));
  }, CONNECT_TIMEOUT_MS);
  socket.once("connect", () => {
    connected = true;
    clearTimeout(timer);
    settle(null, { connection: socket });
  });
  // Stays attached after connect as a no-op so an error in the gap before nodemailer attaches its own handler cannot be unhandled.
  socket.on("error", (error: Error) => {
    clearTimeout(timer);
    if (!connected) settle(error);
  });
  // A socket closed before it connected, by `close()` or after an error, must still settle the callback.
  socket.once("close", () => {
    openSockets.delete(socket);
    clearTimeout(timer);
    if (!connected) {
      settle(Object.assign(new Error("Connection closed before it was established"), { code: "ECONNRESET" }));
    }
  });
}

/**
 * Builds the SMTP transport for a tenant-chosen host. `security: tls` uses implicit TLS, and
 * `security: starttls` requires STARTTLS. Every connection is opened through `connectPinned`. The
 * transport's connect and send failures pass through `mapConnectionFailure`, as the IMAP factory's do.
 */
function buildSmtpTransporter(
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  options: MailServerConnectionOptions,
  onSocket?: (socket: Socket) => void,
  testCa?: string,
  testPort?: number,
) {
  const { endpoint, username } = settings;
  const host = endpoint.host;
  const policy = policyOf(options);
  const lookup = createPolicyLookup(policy);
  // Sockets handed to nodemailer that have connected and not yet closed. nodemailer's own `close()` does not end
  // an in-flight send, so `close()` below destroys these.
  const openSockets = new Set<Socket>();
  const transporter = createTransport({
    host,
    port: testPort ?? endpoint.port,
    secure: endpoint.security === "tls",
    requireTLS: endpoint.security === "starttls",
    auth: { user: username, pass: credential.password },
    tls: { servername: host, ...(testCa ? { ca: testCa } : {}) },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    getSocket: (_socketOptions: unknown, callback: SocketCallback) => {
      const refusal = literalRefusal(host, policy);
      if (refusal !== undefined) {
        callback(refusal);
        return;
      }
      connectPinned(host, testPort ?? endpoint.port, lookup, callback, openSockets, onSocket);
    },
  });
  return { transporter, openSockets };
}

/** Verifies one SMTP endpoint while retaining ownership of the policy-checked TCP socket. */
export async function verifySmtpServerConnection(
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  options: MailServerConnectionOptions = {},
  testOptions?: VerificationTestOptions,
): Promise<VerificationAttempt> {
  if (testOptions && process.env.NODE_ENV !== "test") throw new Error("Verification test options require test mode");
  const owned = new Map<Socket, { closed: Promise<void>; errors: unknown[]; listener: (error: Error) => void }>();
  const observeSocket = (socket: Socket) => {
    const errors: unknown[] = [];
    const listener = (error: Error) => errors.push(error);
    socket.on("error", listener);
    owned.set(socket, { closed: new Promise<void>((resolve) => socket.once("close", resolve)), errors, listener });
  };
  const { transporter, openSockets } = buildSmtpTransporter(
    settings,
    credential,
    options,
    observeSocket,
    testOptions?.ca,
    testOptions?.ports?.[settings.endpoint.port],
  );
  const ownerCancellation = new Error("SMTP verification attempt expired");
  let expired = false;
  const cancellationFailures: unknown[] = [];
  const deadline = setTimeout(() => {
    expired = true;
    for (const socket of openSockets) {
      try {
        socket.destroy(ownerCancellation);
      } catch (error) {
        cancellationFailures.push(error);
      }
    }
  }, testOptions?.deadlineMs ?? 15_000);
  const result = await Promise.resolve()
    .then(() => transporter.verify())
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  clearTimeout(deadline);
  try {
    transporter.close();
  } catch (error) {
    cancellationFailures.push(error);
  }
  for (const socket of openSockets) {
    try {
      socket.destroy();
    } catch (error) {
      cancellationFailures.push(error);
    }
  }
  await Promise.all([...owned.values()].map((entry) => entry.closed));
  for (const [socket, entry] of owned) socket.removeListener("error", entry.listener);
  const secondary = [...owned.values()]
    .flatMap((entry) => entry.errors)
    .filter((error) => error !== ownerCancellation && (result.ok || error !== result.error));
  const failures = [...cancellationFailures, ...secondary];
  if (failures.length) {
    const distinct = [...new Set(result.ok ? failures : [result.error, ...failures])];
    if (distinct.length === 1) throw distinct[0];
    throw new AggregateError(distinct, "SMTP verification had multiple failures");
  }
  if (result.ok) {
    if (expired) throw new Error("SMTP verification completed after its deadline");
    return "success";
  }
  if (result.error === ownerCancellation) return "unreachable";
  if (expired) throw result.error;
  if (isAuthenticationFailure(result.error)) return "authentication";
  if (isOutboundAddressNotAllowed(result.error)) return "unreachable";
  if (
    errorChain(result.error).some(
      (error) => propertyOf(error, "tlsFailed") === true || TLS_FAILURE_CODES.has(codeOf(error) ?? ""),
    )
  )
    return "tls";
  if (isConnectionFailure(result.error)) return "unreachable";
  throw result.error;
}

export function createSmtpTransporter(
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  options: MailServerConnectionOptions = {},
): MailSmtpTransporter {
  const { transporter, openSockets } = buildSmtpTransporter(settings, credential, options);
  return {
    verify: () =>
      transporter.verify().catch((error: unknown) => {
        throw mapConnectionFailure(error);
      }),
    sendMail: (message: SendMailOptions) =>
      transporter.sendMail(message).then(
        (info) => ({ refusedRecipientCount: info.rejected.length }),
        (error: unknown) => {
          throw mapConnectionFailure(error);
        },
      ),
    close: () => {
      transporter.close();
      for (const socket of [...openSockets]) socket.destroy();
    },
  };
}
