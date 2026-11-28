import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/**
 * With `trustProxy`, returns the last `X-Forwarded-For` entry: Caddy's `reverse_proxy` appends the
 * peer it saw, so only the last entry is vouched for. Falls back to the socket peer when the flag
 * is off, the header is absent, or the last entry is not a well-formed IP: the key is bound against
 * an `inet` column, so a malformed hop would fail the login query instead of being throttled.
 */
export function clientIpFromRequest(req: IncomingMessage, options: { trustProxy: boolean }): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (options.trustProxy && typeof forwardedFor === "string" && forwardedFor.length > 0) {
    const lastHop = forwardedFor.slice(forwardedFor.lastIndexOf(",") + 1).trim();
    if (isIP(lastHop) !== 0) return lastHop;
  }
  return req.socket.remoteAddress ?? "0.0.0.0";
}
