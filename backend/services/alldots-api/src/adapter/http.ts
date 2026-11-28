import type { IncomingMessage, ServerResponse } from "node:http";
import { ValidationError } from "@alldots/data";

/** Every listener catches this one class rather than its own copy. */
export class PayloadTooLargeError extends Error {}

/** Bodies carry one tenant's content, so no browser or proxy may keep them. */
export const NO_STORE = "no-store";

/**
 * `Cache-Control: no-store` is written last, so a caller's own `Cache-Control` cannot weaken it.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers, "Cache-Control": NO_STORE });
  res.end(payload);
}

/** No default cap: every caller states its own, because listeners deliberately differ. */
export async function readRawBody(req: IncomingMessage, options: { maxBytes: number }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > options.maxBytes) throw new PayloadTooLargeError("Request body exceeds the maximum allowed size");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * `{}` for an empty body. A parse failure throws `ValidationError`, so malformed JSON takes the
 * same 400 path as any other body-validation failure.
 */
export async function readJsonBody(req: IncomingMessage, options: { maxBytes: number }): Promise<unknown> {
  const raw = await readRawBody(req, options);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

/**
 * `null` when absent, not `Bearer `-prefixed, or blank. Never falls back to a cookie; that is
 * `authHandler.ts`'s `extractToken`.
 */
export function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}
