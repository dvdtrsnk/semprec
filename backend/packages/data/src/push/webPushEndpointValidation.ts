import { ValidationError } from "../errors.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";

const ENDPOINT_ERROR_MESSAGE =
  "'endpoint' must be an https URL to a public push service host on port 443, without credentials";

/**
 * SSRF guard for an attacker-chosen URL the server later POSTs to. Only `https:` on port 443, no
 * userinfo, and a DNS hostname other than `localhost`: every real push service is a DNS name, so
 * rejecting all IP literals closes private ranges without a range table.
 *
 * Returns the input unchanged because it is the `ON CONFLICT (endpoint)` identity. DNS rebinding
 * is not covered here.
 */
export function validateWebPushEndpoint(endpoint: string): string {
  if (!isBaselineOutboundUrl(endpoint)) {
    throw new ValidationError(ENDPOINT_ERROR_MESSAGE, { field: "endpoint" });
  }
  return endpoint;
}
