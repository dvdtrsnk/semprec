import { isIP } from "node:net";
import { ValidationError } from "../errors.js";

const ENDPOINT_ERROR_MESSAGE =
  "'endpoint' must be an https URL to a public push service host on port 443, without credentials";

/**
 * Guards a web-push subscription's `endpoint` — an attacker-chosen URL the server later POSTs to
 * with a signed VAPID JWT — against server-side request forgery into loopback and private
 * services. Accepts only an `https:` URL with no userinfo, no explicit port other than the
 * default 443 (which `URL` normalises away), and a DNS hostname that is neither `localhost`,
 * `*.localhost` nor an IP literal of any kind (every real push service is a DNS name, so rejecting
 * all literals closes loopback, RFC 1918, link-local, CGNAT and IPv4-mapped IPv6 without a range
 * table).
 *
 * Returns the input unchanged: the stored value is the `ON CONFLICT (endpoint)` identity, so it is
 * never normalised. Any rule failing — including a parse failure — throws `ValidationError` with
 * `details.field === "endpoint"`.
 *
 * Not covered here: a DNS name that resolves to an internal address (DNS rebinding). Egress
 * filtering is the deployment's job.
 */
export function validateWebPushEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // The only failure `new URL` has is an unparseable input, which is exactly this validation error.
    throw endpointError();
  }

  // `URL` already lowercases the host and canonicalises IPv4 shorthands (`2130706433`, `127.1`,
  // a trailing dot) to dotted-quad; a DNS name's trailing root dot survives, so drop it before the
  // `localhost` check or `localhost.` would pass.
  const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isIP(bareHost) !== 0
  ) {
    throw endpointError();
  }
  return endpoint;
}

function endpointError(): ValidationError {
  return new ValidationError(ENDPOINT_ERROR_MESSAGE, { field: "endpoint" });
}
