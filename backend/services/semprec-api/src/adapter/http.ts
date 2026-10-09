import type { IncomingMessage, ServerResponse } from "node:http";
import { ValidationError } from "@semprec/data";

/** Thrown by `readRawBody`/`readJsonBody` once a request body exceeds its caller-supplied `maxBytes`; every listener in this service catches this one class rather than its own copy. */
export class PayloadTooLargeError extends Error {}

/** `Cache-Control` value for every response this service writes: bodies carry one tenant's content, so no browser or proxy may keep them. */
export const NO_STORE = "no-store";

/**
 * Writes a JSON response: `status`, `Content-Type: application/json; charset=utf-8`, and any caller-supplied `headers` merged in (e.g. `authHandler.ts`'s `Set-Cookie`). `Cache-Control: no-store` is written last, so a caller's own `Cache-Control` cannot weaken it.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers, "Cache-Control": NO_STORE });
  res.end(payload);
}

/** Reads the request body into a single `Buffer`, capped at `options.maxBytes`; throws `PayloadTooLargeError` once the accumulated size exceeds the cap. No default cap — every caller states its own, because listeners in this service deliberately differ. */
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
 * `readRawBody`, then `{}` for an empty body, else `JSON.parse`; a parse failure throws
 * `ValidationError` rather than crashing the listener. Every bespoke handler that calls this
 * already lets a body-shape `ValidationError` (missing/wrong-typed field, etc.) fall through to
 * its outer `catch (err instanceof ChokePointError)` and answer with `toPublicErrorBody`'s
 * `{ error, code, details }` envelope — a malformed-JSON body takes that same path deliberately,
 * so "the JSON didn't parse" reads as one more body-validation failure alongside the rest instead
 * of reverting to the flat `{ error }` shape a bespoke per-listener `JsonParseError` catch used to
 * produce. Status stays 400 either way.
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

/** Reads the `Authorization: Bearer <token>` header; `null` when absent, not `Bearer `-prefixed, or empty/whitespace-only after trimming. Never falls back to a cookie — that is `authHandler.ts`'s `extractToken`'s job. */
export function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}
