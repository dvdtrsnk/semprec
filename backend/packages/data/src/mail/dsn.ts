/**
 * RFC 3462/3464 bounce detection (`multipart/report; report-type=delivery-status`). Ingest still
 * threads a DSN normally but tags it `messageKind: 'dsn'`.
 */
export function isDeliveryStatusReport(
  mimeType: string | undefined | null,
  params: Record<string, string> | undefined,
): boolean {
  if (!mimeType || mimeType.toLowerCase() !== "multipart/report") return false;
  const reportType = Object.entries(params ?? {}).find(([key]) => key.toLowerCase() === "report-type")?.[1];
  return (reportType ?? "").trim().replace(/^"|"$/g, "").toLowerCase() === "delivery-status";
}

export function parseContentTypeHeader(
  value: string | undefined | null,
): { type: string; params: Record<string, string> } | null {
  if (!value) return null;
  const [typePart = "", ...paramParts] = value.split(";").map((s) => s.trim());
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).trim().toLowerCase()] = part
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, "");
  }
  return { type: typePart.toLowerCase(), params };
}
