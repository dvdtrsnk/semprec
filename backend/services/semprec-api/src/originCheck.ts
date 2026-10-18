import type { IncomingMessage } from "node:http";

/**
 * Same-origin rule for requests a browser can send cross-origin (issue #1044). A request with no
 * `Origin` header passes: native clients, bearer-token MCP clients, the Graph webhook and `curl`
 * never send one. A request that does carry `Origin` passes only when it is an `http:` or `https:`
 * URL whose host (hostname and port) equals the request's `Host` header. `Origin: null`, an
 * unparseable value, another scheme, a missing `Host` and any mismatch are refused.
 *
 * The comparison uses only `Host`. A client-settable forwarding header such as `X-Forwarded-Host`
 * is never read, so a foreign page cannot make its own origin match.
 */
export function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;

  const host = req.headers.host;
  if (!host) return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.host === host.toLowerCase();
}
