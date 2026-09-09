import type { IncomingMessage, ServerResponse } from "node:http";
import { getAiUsageReport, ChokePointError } from "@semprec/data";
import type { Pool } from "pg";
import { authenticateRequest } from "./authHandler.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

/**
 * Handles `GET /api/ai-usage?from=...&to=...` for issue #121. Returns a request listener
 * compatible with `http.createServer` — the caller owns the actual server/listen(), matching
 * the wiring-function pattern used by `startRealtimeServer` in `@semprec/realtime`.
 *
 * Gated by `authenticateRequest` (issue #143) — the same session middleware `authHandler.ts`
 * uses for its own routes, replacing this handler's former stopgap shared-secret bearer token.
 */
export function createAiUsageRequestListener(pool: Pool) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      await authenticateRequest(pool, req);

      if (req.method !== "GET" || url.pathname !== "/api/ai-usage") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!from || !to) {
        sendJson(res, 400, { error: "'from' and 'to' query parameters are required" });
        return;
      }

      const report = await getAiUsageReport(pool, { from, to });
      sendJson(res, 200, report);
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
        return;
      }
      console.error(`Unexpected error in ${req.method} ${url.pathname}:`, err);
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
