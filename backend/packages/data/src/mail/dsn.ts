/**
 * RFC 3462/3464 delivery-status-notification detection: a top-level `Content-Type:
 * multipart/report; report-type=delivery-status` is the standard signal an MTA sends for a
 * bounce/DSN — distinct from an ordinary human reply, which threading.ts would otherwise
 * thread and treat identically (mail/ingest.ts still threads it via References/In-Reply-To,
 * it just also tags it `messageKind: 'dsn'` so a later rendering layer can tell them apart).
 */
export function isDeliveryStatusReport(mimeType: string | undefined | null, params: Record<string, string> | undefined): boolean {
  if (!mimeType || mimeType.toLowerCase() !== "multipart/report") return false;
  const reportType = Object.entries(params ?? {}).find(([key]) => key.toLowerCase() === "report-type")?.[1];
  return (reportType ?? "").trim().replace(/^"|"$/g, "").toLowerCase() === "delivery-status";
}

/** Splits a raw `Content-Type: multipart/report; report-type=delivery-status` header value into its type and parameters. */
export function parseContentTypeHeader(value: string | undefined | null): { type: string; params: Record<string, string> } | null {
  if (!value) return null;
  const [typePart, ...paramParts] = value.split(";").map((s) => s.trim());
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { type: typePart.toLowerCase(), params };
}
