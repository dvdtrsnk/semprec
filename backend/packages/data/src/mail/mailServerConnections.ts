import { connect, isIP, type LookupFunction, type Socket } from "node:net";
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

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : "NonError";
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
 * apart from an unreachable server. The host name and the error's name and code are logged; the
 * resolved address is not.
 */
function mapConnectionFailure(error: unknown, host: string): unknown {
  if (isAuthenticationFailure(error) || !isConnectionFailure(error)) return error;
  const reasonCode = errorChain(error)
    .map(codeOf)
    .find((code) => code !== undefined);
  logger.warn({ host, errorName: nameOf(error), reasonCode }, "Mail server could not be reached");
  return new MailServerUnreachableError();
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

function closeAfterFailedConnect(client: ImapFlow, host: string): void {
  try {
    client.close();
  } catch (error) {
    // The connect failure is the error the caller needs; a failed close is logged and not rethrown.
    logger.warn({ host, errorName: nameOf(error) }, "Closing an IMAP connection after a failed connect failed");
  }
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
  const { endpoint, username } = settings;
  const policy = policyOf(options);
  const refusal = literalRefusal(endpoint.host, policy);
  if (refusal !== undefined) throw mapConnectionFailure(refusal, endpoint.host);
  const client = new ImapFlow({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.security === "tls",
    ...(endpoint.security === "starttls" ? { doSTARTTLS: true } : {}),
    auth: { user: username, pass: credential.password },
    tls: { servername: endpoint.host, lookup: createPolicyLookup(policy) },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    ...(options.maxIdleTime !== undefined ? { maxIdleTime: options.maxIdleTime } : {}),
    ...(options.socketTimeout !== undefined ? { socketTimeout: options.socketTimeout } : {}),
    // imapflow's default logger writes the protocol traffic, server responses included, to the console; that traffic can carry folder names and message subjects.
    logger: false,
  });
  // imapflow throws from its event emitter when an error has no listener, and it can emit after connect() settles.
  client.on("error", (error: unknown) => {
    logger.warn({ host: endpoint.host, errorName: nameOf(error) }, "IMAP connection error");
  });
  try {
    await client.connect();
  } catch (error) {
    closeAfterFailedConnect(client, endpoint.host);
    throw mapConnectionFailure(error, endpoint.host);
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
): void {
  const socket = connect({ host, port, lookup });
  openSockets.add(socket);
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
export function createSmtpTransporter(
  settings: MailServerConnectionSettings,
  credential: MailServerCredential,
  options: MailServerConnectionOptions = {},
): MailSmtpTransporter {
  const { endpoint, username } = settings;
  const host = endpoint.host;
  const policy = policyOf(options);
  const lookup = createPolicyLookup(policy);
  // Sockets handed to nodemailer that have connected and not yet closed. nodemailer's own `close()` does not end
  // an in-flight send, so `close()` below destroys these.
  const openSockets = new Set<Socket>();
  const transporter = createTransport({
    host,
    port: endpoint.port,
    secure: endpoint.security === "tls",
    requireTLS: endpoint.security === "starttls",
    auth: { user: username, pass: credential.password },
    tls: { servername: host },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    getSocket: (_socketOptions: unknown, callback: SocketCallback) => {
      const refusal = literalRefusal(host, policy);
      if (refusal !== undefined) {
        callback(refusal);
        return;
      }
      connectPinned(host, endpoint.port, lookup, callback, openSockets);
    },
  });
  return {
    verify: () =>
      transporter.verify().catch((error: unknown) => {
        throw mapConnectionFailure(error, host);
      }),
    sendMail: (message: SendMailOptions) =>
      transporter.sendMail(message).then(
        (info) => ({ refusedRecipientCount: info.rejected.length }),
        (error: unknown) => {
          throw mapConnectionFailure(error, host);
        },
      ),
    close: () => {
      transporter.close();
      for (const socket of [...openSockets]) socket.destroy();
    },
  };
}
