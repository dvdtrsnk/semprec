/**
 * Shared by the Gmail/Graph REST clients: a 30s request timeout bounds how long a response
 * can take to *arrive*, but not how large it is once it does — a paginated `/messages` or
 * `/messages/delta` page can carry hundreds of full message bodies. Reads the body as a
 * stream and aborts once `maxBytes` is exceeded, instead of trusting `response.json()` (which
 * buffers the whole body internally regardless of size) or a `content-length` header (which a
 * chunked-encoding response, or a misbehaving/compromised proxy, may omit or misreport).
 */
const DEFAULT_MAX_JSON_BYTES = 32 * 1024 * 1024;

export async function readJsonWithLimit<T>(response: Response, maxBytes: number = DEFAULT_MAX_JSON_BYTES): Promise<T> {
  // A null body is genuinely empty (not an unread stream) — nothing to bound, so this never
  // falls back to an uncapped `response.text()` the way the size guard below exists to avoid.
  if (!response.body) throw new Error("Response has no body to parse as JSON");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`Response body exceeded ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
