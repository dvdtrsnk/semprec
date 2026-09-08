import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { getAiUsageReport, ChokePointError, type Queryable } from "@semprec/data";

export interface AiUsageHandlerOptions {
  /**
   * Shared-secret bearer token. Explicit parameter (not read from process.env here) so the
   * caller decides where it comes from, and so this stopgap is trivial to swap out once the
   * auth-v1 epic (#138-143) lands a real session/credential mechanism.
   */
  authToken: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

/** Constant-time so a network caller can't recover the token byte-by-byte from response timing. */
function isAuthorized(req: IncomingMessage, authToken: string): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(authToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Handles `GET /api/ai-usage?from=...&to=...` for issue #121. Returns a request listener
 * compatible with `http.createServer` — the caller owns the actual server/listen(), matching
 * the wiring-function pattern used by `startRealtimeServer` in `@semprec/realtime`.
 */
export function createAiUsageRequestListener(pool: Queryable, options: AiUsageHandlerOptions) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method !== "GET" || url.pathname !== "/api/ai-usage") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (!isAuthorized(req, options.authToken)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) {
      sendJson(res, 400, { error: "'from' and 'to' query parameters are required" });
      return;
    }

    try {
      const report = await getAiUsageReport(pool, { from, to });
      sendJson(res, 200, report);
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
        return;
      }
      console.error("Unexpected error in GET /api/ai-usage:", err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * `http.createServer` discards its listener's return value, so handing it an `async`
   * function means any rejection that escapes the try/catch above — a `sendJson` that throws
   * on an unserializable body, a malformed `authorization` header reaching `Buffer.from` —
   * becomes an unhandled rejection, which Node turns into a process exit. The whole service
   * would go down over one bad request. Keeping the boundary synchronous confines it to a
   * 500 for that request.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      console.error("Unhandled error in the ai-usage request listener:", err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
