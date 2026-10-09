import { isIP } from "node:net";

/**
 * The baseline every stored outbound URL passes when it is stored
 * (docs/adr/2026-09-27-ssrf-protection-for-stored-outbound-urls.md): an `https:` URL with no
 * userinfo, no explicit port other than the default 443 (which `URL` normalises away), and a DNS
 * hostname that is neither `localhost`, `*.localhost` nor an IP literal of any kind — rejecting
 * all literals closes loopback, RFC 1918, link-local, CGNAT and IPv4-mapped IPv6 without a range
 * table. An unparseable input is not a baseline URL.
 *
 * Not covered here: a DNS name that resolves to an internal address (DNS rebinding); that is a
 * connect-time check.
 */
export function isBaselineOutboundUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The only failure `new URL` has is an unparseable input, which is exactly "not a baseline URL".
    return false;
  }

  // `URL` already lowercases the host and canonicalises IPv4 shorthands (`2130706433`, `127.1`,
  // a trailing dot) to dotted-quad; a DNS name's trailing root dot survives, so drop it before the
  // `localhost` check or `localhost.` would pass.
  const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  return !(
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isIP(bareHost) !== 0
  );
}
