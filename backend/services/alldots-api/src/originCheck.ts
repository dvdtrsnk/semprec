import type { IncomingMessage } from "node:http";

/**
 * A request with no `Origin` passes: native clients, bearer-token MCP clients, the Graph webhook
 * and `curl` never send one. Otherwise `Origin` must be an `http:`/`https:` URL whose host and port
 * equal the `Host` header; `Origin: null`, unparseable values, other schemes, a missing `Host` and
 * any mismatch are refused.
 *
 * Only `Host` is compared. A client-settable header such as `X-Forwarded-Host` is never read, so a
 * foreign page cannot make its origin match.
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
