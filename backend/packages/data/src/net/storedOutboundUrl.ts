import { isIP } from "node:net";

/**
 * Write-time SSRF baseline for stored outbound URLs: `https:`, no userinfo, default port only, and a DNS hostname
 * that is not `localhost`/`*.localhost` or any IP literal (rejecting all literals avoids a range table). DNS
 * rebinding is a connect-time check (`outboundAddressPolicy.ts`).
 */
export function isBaselineOutboundUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // `URL` lowercases and canonicalises IPv4 shorthands, but a trailing root dot survives; drop it so `localhost.`
  // is caught.
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
