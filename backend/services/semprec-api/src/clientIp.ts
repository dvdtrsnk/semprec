import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/**
 * The client address a request is attributed to, as a throttle key (issue #635) — validated as an
 * IP address but never normalised beyond trimming.
 *
 * With `trustProxy`, returns the last comma-separated `X-Forwarded-For` entry: Caddy's
 * `reverse_proxy` appends the peer address it saw to whatever header the client sent, so only the
 * last entry is vouched for; every earlier entry is client-controlled and never used. Falls back to
 * the socket's peer address when the flag is off, the header is absent, or its last entry is not a
 * well-formed IPv4/IPv6 address — the key is bound against an `inet` column, so a malformed hop
 * would otherwise fail the login query instead of being throttled.
 */
export function clientIpFromRequest(req: IncomingMessage, options: { trustProxy: boolean }): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (options.trustProxy && typeof forwardedFor === "string" && forwardedFor.length > 0) {
    const lastHop = forwardedFor.slice(forwardedFor.lastIndexOf(",") + 1).trim();
    if (isIP(lastHop) !== 0) return lastHop;
  }
  return req.socket.remoteAddress ?? "0.0.0.0";
}
