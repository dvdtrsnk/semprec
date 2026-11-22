// The only way a CalDAV request reaches the network: `tsdav` is handed this fetch on every call. It sends through
// `createOutboundHttp()` (the connect-time address policy, https only outside tests), adds the account's Basic
// credential, follows at most three redirects itself so each target passes the same policy and stays inside the
// credential's scope, bounds each request by a timeout and its body by a size cap, and turns transport failures into
// the sync's provider errors.
import { logger } from "../../../logger.js";
import { isStorableCalDavUrl } from "../../../../mail/mailServerSettingsStore.js";
import {
  createOutboundHttp,
  currentOutboundAddressPolicy,
  isOutboundAddressNotAllowed,
  type OutboundAddressPolicy,
  type OutboundHttp,
} from "../../../../net/outboundAddressPolicy.js";
import { CalendarSyncProviderError } from "../../adapter.js";

const CALDAV_REQUEST_TIMEOUT_MS = 20_000;
const CALDAV_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const CALDAV_MAX_REDIRECTS = 3;

/** Redirects that keep the method and body; a CalDAV server has no reason to send a 303. */
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** One message for a refused address and an unreachable server, so neither tells the caller which it was. */
function caldavUnreachable(): CalendarSyncProviderError {
  return new CalendarSyncProviderError("providerUnavailable", "The CalDAV server could not be reached");
}

function caldavTimeout(): CalendarSyncProviderError {
  return new CalendarSyncProviderError("timeout", "The CalDAV server did not answer in time");
}

/**
 * The failures a request can have on the way to a response: a denied address (thrown before connecting or by the
 * pinned lookup) and `undici`'s `TypeError("fetch failed")`, which carries every connection, DNS and TLS failure.
 */
function isTransportFailure(error: unknown): boolean {
  return isOutboundAddressNotAllowed(error) || (error instanceof TypeError && error.message === "fetch failed");
}

/** Where discovery of an iCloud account starts; its answers name the account's own `pNN-caldav.icloud.com` host. */
const ICLOUD_CALDAV_ORIGIN = "https://caldav.icloud.com";

/**
 * Where the account's Basic credential may be sent: the origin discovery starts at (the account's CalDAV address, the
 * well-known address of its domain, or iCloud's root) and, for iCloud only, the other hosts under `icloud.com` that
 * Apple's discovery delegates to, over https on the default port. A redirect or an address a server names outside it
 * is refused, so a server never takes the login to a host the account was not set up with. The one exception is the
 * well-known delegation of a session that resolves the account's server (`withCalDavSession`).
 */
export interface CalDavCredentialScope {
  allows(url: URL): boolean;
}

function isIcloudHost(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    (url.hostname === "icloud.com" || url.hostname.endsWith(".icloud.com"))
  );
}

export function caldavCredentialScope(start: URL): CalDavCredentialScope {
  const origin = start.origin;
  const icloud = origin === ICLOUD_CALDAV_ORIGIN;
  return {
    allows: (url) => url.origin === origin || (icloud && isIcloudHost(url)),
  };
}

function outsideScope(): CalendarSyncProviderError {
  return new CalendarSyncProviderError("invalidResponse", "The CalDAV server named an address outside its own");
}

const WELL_KNOWN_PATHS = new Set(["/.well-known/caldav", "/.well-known/caldav/"]);

function isWellKnownAddress(url: URL): boolean {
  return WELL_KNOWN_PATHS.has(url.pathname) && url.search === "";
}

/**
 * Whether a well-known address may delegate the account to `target` (RFC 6764): an address the account could have
 * been set up with (`isStorableCalDavUrl`: https, a DNS name that is no local name, the default port, no userinfo).
 * Under the test policy any address without userinfo; the outbound policy still vets every request.
 */
export function allowsWellKnownDelegation(target: URL, policy: OutboundAddressPolicy): boolean {
  if (policy.isTestPolicy) return target.username === "" && target.password === "";
  return isStorableCalDavUrl(target.href);
}

export interface CalDavSession {
  /** Handed to every `tsdav` call. */
  readonly fetch: typeof fetch;
  /** The address the last response came from, after redirects. Calls through one session run one at a time. */
  lastResponseUrl(): URL | null;
  /** Whether an address may be requested with the account's login; every request and redirect is held to it. */
  inScope(url: URL): boolean;
  /**
   * Where the account's well-known address delegated it in this session, the CalDAV server the account has from then
   * on; `null` when it did not.
   */
  delegatedServer(): URL | null;
}

/** The session's scope, which a well-known delegation moves once. */
interface SessionScope {
  current: CalDavCredentialScope;
  /** The address whose redirect may move the scope; taken by the session's first request. */
  delegationFrom: URL | null;
  delegatedTo: URL | null;
}

interface SessionOptions {
  authorization: string;
  signal: AbortSignal;
  scope: SessionScope;
  policy: OutboundAddressPolicy;
}

/**
 * Checks a redirect from `from` to `to` against the scope. Outside it only the first hop of the session's first
 * request may go, from the well-known start (`delegationFrom`) to a server `allowsWellKnownDelegation`, which then
 * becomes the scope.
 */
function followRedirect(
  scope: SessionScope,
  delegationFrom: URL | null,
  hop: { from: URL; to: URL },
  policy: OutboundAddressPolicy,
): void {
  if (scope.current.allows(hop.to)) return;
  if (delegationFrom === null || hop.from.href !== delegationFrom.href || !allowsWellKnownDelegation(hop.to, policy)) {
    throw outsideScope();
  }
  const server = new URL(hop.to);
  server.hash = "";
  scope.current = caldavCredentialScope(server);
  scope.delegatedTo = server;
}

async function readCappedBody(response: Response, signal: AbortSignal, timeout: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal.aborted) throw error;
        if (timeout.aborted) throw caldavTimeout();
        // The body stream fails only when the connection does.
        throw caldavUnreachable();
      }
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new TypeError("The CalDAV response body is not a byte stream");
      total += value.byteLength;
      if (total > CALDAV_MAX_RESPONSE_BYTES) {
        throw new CalendarSyncProviderError("invalidResponse", "The CalDAV response is larger than the cap");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (error) {
    // The redirect is followed anyway; an unread body only keeps its socket until the session closes.
    logger.warn({ errorName: error instanceof Error ? error.name : typeof error }, "CalDAV redirect body not released");
  }
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof Request) throw new TypeError("The CalDAV fetch takes a URL, not a Request");
  return new URL(input);
}

function requestBody(body: RequestInit["body"]): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "string") throw new TypeError("The CalDAV fetch sends only a string body");
  return body;
}

function createSessionFetch(http: OutboundHttp, options: SessionOptions, record: (url: URL) => void): typeof fetch {
  return async (input, init) => {
    let url = requestUrl(input);
    const headers = new Headers(init?.headers);
    // Sent to every hop, each of which is inside the scope: iCloud's root and a well-known delegation hand the
    // account to its own server.
    headers.set("Authorization", options.authorization);
    const body = requestBody(init?.body);
    const method = init?.method ?? "GET";
    const timeout = AbortSignal.timeout(CALDAV_REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([options.signal, timeout]);
    let delegationFrom = options.scope.delegationFrom;
    options.scope.delegationFrom = null;
    for (let hop = 0; ; hop += 1) {
      if (!options.scope.current.allows(url)) throw outsideScope();
      let response: Response;
      try {
        response = await http.fetch(url.href, {
          method,
          headers: Object.fromEntries(headers.entries()),
          ...(body === undefined ? {} : { body }),
          signal,
          redirect: "manual",
        });
      } catch (error) {
        // The pass's own deadline is the job's to report.
        if (options.signal.aborted) throw error;
        if (timeout.aborted) throw caldavTimeout();
        if (isTransportFailure(error)) throw caldavUnreachable();
        throw error;
      }
      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        await discardBody(response);
        if (hop === CALDAV_MAX_REDIRECTS) {
          throw new CalendarSyncProviderError("invalidResponse", "The CalDAV server redirected too often");
        }
        // The next request is vetted by the outbound policy like the first: protocol, address literal, lookup.
        const next = new URL(location, url);
        followRedirect(options.scope, delegationFrom, { from: url, to: next }, options.policy);
        delegationFrom = null;
        url = next;
        continue;
      }
      const bytes = await readCappedBody(response, options.signal, timeout);
      record(url);
      return new Response(NULL_BODY_STATUSES.has(response.status) ? null : bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
  };
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export interface CalDavLogin {
  username: string;
  password: string;
}

/**
 * Runs `fn` with a session whose HTTP clients are closed when it settles. `start` is where the account's discovery
 * starts, which sets the credential's scope (`caldavCredentialScope`). With `resolveServer`, for an account that has
 * no CalDAV server stored yet, a redirect of the session's first request from a well-known `start` to another server
 * that `allowsWellKnownDelegation` moves the scope there (`delegatedServer`); every later redirect and address is held
 * to that scope. `policy` defaults to the process's outbound policy.
 */
export async function withCalDavSession<T>(
  login: CalDavLogin,
  options: { signal: AbortSignal; start: URL; resolveServer?: boolean; policy?: OutboundAddressPolicy },
  fn: (session: CalDavSession) => Promise<T>,
): Promise<T> {
  const policy = options.policy ?? currentOutboundAddressPolicy();
  const http = createOutboundHttp(policy);
  const scope: SessionScope = {
    current: caldavCredentialScope(options.start),
    delegationFrom: options.resolveServer === true && isWellKnownAddress(options.start) ? options.start : null,
    delegatedTo: null,
  };
  let last: URL | null = null;
  const session: CalDavSession = {
    fetch: createSessionFetch(
      http,
      { authorization: basicAuthorization(login.username, login.password), signal: options.signal, scope, policy },
      (url) => {
        last = url;
      },
    ),
    lastResponseUrl: () => last,
    inScope: (url) => scope.current.allows(url),
    delegatedServer: () => scope.delegatedTo,
  };
  try {
    return await fn(session);
  } finally {
    try {
      await http.close();
    } catch (error) {
      // The work's own outcome is what the caller must see; a leaked agent is only logged.
      logger.warn({ errorName: error instanceof Error ? error.name : typeof error }, "CalDAV session did not close");
    }
  }
}
