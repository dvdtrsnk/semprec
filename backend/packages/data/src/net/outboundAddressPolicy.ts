import dns from "node:dns";
import https from "node:https";
import { BlockList, Socket, isIP, type LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  Agent as UndiciAgent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from "undici";

/**
 * Connect-time address checks for requests to user-supplied URLs
 * (docs/adr/2026-10-16-connect-time-outbound-address-checks.md). The stored-URL baseline
 * (`storedOutboundUrl.ts`) rejects IP literals and `localhost` at write time; this module covers
 * what that cannot: a DNS name that resolves to an internal address. The name is resolved once,
 * every returned address is vetted, and the socket connects to exactly the vetted address.
 */

const DENIED_IPV4_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const DENIED_IPV6_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["100::", 64],
];

const deniedAddresses = new BlockList();
for (const [network, prefix] of DENIED_IPV4_SUBNETS) deniedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of DENIED_IPV6_SUBNETS) deniedAddresses.addSubnet(network, prefix, "ipv6");

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");

/** Raised when a request would reach an address the active policy denies. The message names the host only. */
export class OutboundAddressNotAllowedError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(`Outbound connection to host "${host}" is not allowed`);
    this.name = "OutboundAddressNotAllowedError";
    this.host = host;
  }
}

/** True when `err`, or any error in its `cause` chain, is an `OutboundAddressNotAllowedError`. */
export function isOutboundAddressNotAllowed(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof OutboundAddressNotAllowedError) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

/** The eight 16-bit groups of an IPv6 address; `URL` canonicalises it first, so no dotted-quad tail remains. */
function ipv6Groups(address: string): number[] {
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const [head = "", tail] = canonical.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  if (tail === undefined) return headGroups.map((group) => parseInt(group, 16));
  const tailGroups = tail === "" ? [] : tail.split(":");
  const zeros = new Array<string>(8 - headGroups.length - tailGroups.length).fill("0");
  return [...headGroups, ...zeros, ...tailGroups].map((group) => parseInt(group, 16));
}

/** The IPv4 address embedded in an IPv4-mapped (`::ffff:0:0/96`) or NAT64 (`64:ff9b::/96`) address, or `null`. */
function embeddedIpv4(address: string): string | null {
  const groups = ipv6Groups(address);
  const prefix = groups.slice(0, 6).join(":");
  if (prefix !== "0:0:0:0:0:65535" && prefix !== "100:65435:0:0:0:0") return null;
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** Splits an address into the family and address `BlockList` should judge, following an embedded IPv4. `null` for a non-IP. */
function classify(address: string): { address: string; family: "ipv4" | "ipv6" } | null {
  const bare = address.split("%")[0] ?? "";
  switch (isIP(bare)) {
    case 4:
      return { address: bare, family: "ipv4" };
    case 6: {
      const embedded = embeddedIpv4(bare);
      return embedded === null ? { address: bare, family: "ipv6" } : { address: embedded, family: "ipv4" };
    }
    default:
      return null;
  }
}

/** False for any address in a denied range (see the ADR), for an IPv4-mapped or NAT64 form of one, and for a non-IP. */
export function isPublicAddress(address: string): boolean {
  const classified = classify(address);
  return classified !== null && !deniedAddresses.check(classified.address, classified.family);
}

function isLoopbackAddress(address: string): boolean {
  const classified = classify(address);
  return classified !== null && loopbackAddresses.check(classified.address, classified.family);
}

/** What one policy lets an outbound request reach. */
export interface OutboundAddressPolicy {
  /** True only for the test policy; a caller skips its stored-URL baseline re-check under it. */
  readonly isTestPolicy: boolean;
  readonly protocols: readonly string[];
  /** Whether a resolved address may be connected to. */
  allowsResolvedAddress(address: string): boolean;
  /** Whether a URL whose host is this IP literal may be requested; lookup never runs for a literal. */
  allowsIpLiteral(address: string): boolean;
}

const PUBLIC_ONLY_POLICY: OutboundAddressPolicy = {
  isTestPolicy: false,
  protocols: ["https:"],
  allowsResolvedAddress: isPublicAddress,
  allowsIpLiteral: () => false,
};

const LOOPBACK_FOR_TESTS_POLICY: OutboundAddressPolicy = {
  isTestPolicy: true,
  protocols: ["https:", "http:"],
  allowsResolvedAddress: (address) => isPublicAddress(address) || isLoopbackAddress(address),
  allowsIpLiteral: (address) => isPublicAddress(address) || isLoopbackAddress(address),
};

let defaultPolicy: OutboundAddressPolicy = PUBLIC_ONLY_POLICY;

/** The policy used when a caller passes none: public-only, unless a test switched it. */
export function currentOutboundAddressPolicy(): OutboundAddressPolicy {
  return defaultPolicy;
}

/**
 * Switches the process-wide default policy to one that also permits loopback and `http:`, so tests
 * can reach contract servers on `http://127.0.0.1`. Returns the restore function. Process-wide
 * because those servers are reached through call paths that take no policy argument.
 */
export function allowLoopbackOutboundForTests(): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("allowLoopbackOutboundForTests() must only be called in tests");
  }
  const previous = defaultPolicy;
  defaultPolicy = LOOPBACK_FOR_TESTS_POLICY;
  return () => {
    defaultPolicy = previous;
  };
}

/**
 * A `dns.lookup`-compatible function that resolves every address of `hostname` once and fails with
 * `OutboundAddressNotAllowedError` unless the policy allows all of them. On success it hands the
 * socket the vetted address (or, when the socket asks for `all`, the vetted list), so the socket
 * never resolves the name a second time.
 */
function createPolicyLookup(policy: OutboundAddressPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, "");
        return;
      }
      const first = addresses[0];
      if (first === undefined || !addresses.every((entry) => policy.allowsResolvedAddress(entry.address))) {
        callback(new OutboundAddressNotAllowedError(hostname), "");
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, first.address, first.family);
      }
    });
  };
}

/** The public-only lookup; see `createPolicyLookup`. */
export const publicOnlyLookup: LookupFunction = createPolicyLookup(PUBLIC_ONLY_POLICY);

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function assertRequestTargetAllowed(url: URL, policy: OutboundAddressPolicy): void {
  const host = stripBrackets(url.hostname);
  if (!policy.protocols.includes(url.protocol)) throw new OutboundAddressNotAllowedError(host);
  if (isIP(host) !== 0 && !policy.allowsIpLiteral(host)) throw new OutboundAddressNotAllowedError(host);
}

/** An `https.Agent` whose sockets resolve through the policy lookup and refuse a denied IP-literal host, which lookup never sees. */
class PolicyHttpsAgent extends https.Agent {
  readonly #policy: OutboundAddressPolicy;

  constructor(policy: OutboundAddressPolicy) {
    super({ lookup: createPolicyLookup(policy) });
    this.#policy = policy;
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const host = stripBrackets(options.host ?? options.hostname ?? "");
    if (isIP(host) !== 0 && !this.#policy.allowsIpLiteral(host)) {
      // A socket that never connects and is destroyed with the refusal: the request fails with this
      // error through its normal `error` event, exactly as for a refused lookup.
      const refused = new Socket();
      const error = new OutboundAddressNotAllowedError(host);
      process.nextTick(() => refused.destroy(error));
      return refused;
    }
    return super.createConnection(options, callback);
  }
}

/**
 * The request fields the MCP SDK sends (method, headers, a string or `URLSearchParams` body, an
 * abort signal), copied into `undici`'s own types. `undici` 8 and the global `fetch` declare the
 * same web types from two different packages, so they are rebuilt here rather than cast.
 */
function toUndiciInit(init: RequestInit | undefined, dispatcher: UndiciAgent): UndiciRequestInit {
  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof URLSearchParams)) {
    throw new TypeError("Outbound fetch supports only a string or URLSearchParams request body");
  }
  return {
    method: init?.method,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body,
    signal: init?.signal,
    redirect: "error",
    dispatcher,
  };
}

/** The `undici` response as a global `Response`; the body stream is handed over as-is. */
function toGlobalResponse(response: UndiciResponse): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
  });
}

export interface OutboundHttp {
  /** Requests through the policy's pinned lookup; refuses a denied protocol or IP-literal host, and refuses redirects. */
  readonly fetch: FetchLike;
  /** For libraries that take an `https.Agent` (web-push). */
  readonly httpsAgent: https.Agent;
  /** Destroys both connection pools. */
  close(): Promise<void>;
}

/** Builds the HTTP clients for one use under `policy` (default: the current module policy). The caller closes them. */
export function createOutboundHttp(policy: OutboundAddressPolicy = currentOutboundAddressPolicy()): OutboundHttp {
  const dispatcher = new UndiciAgent({ connect: { lookup: createPolicyLookup(policy) } });
  const httpsAgent = new PolicyHttpsAgent(policy);

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    assertRequestTargetAllowed(url, policy);
    return toGlobalResponse(await undiciFetch(url, toUndiciInit(init, dispatcher)));
  };

  return {
    fetch,
    httpsAgent,
    close: async () => {
      httpsAgent.destroy();
      await dispatcher.destroy();
    },
  };
}
