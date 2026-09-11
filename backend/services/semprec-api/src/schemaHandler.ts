import type { IncomingMessage, ServerResponse } from "node:http";
import { withTransaction, ChokePointError, generateSchemaProjection, toManifestLocale } from "@semprec/data";
import type { Pool } from "pg";
import { authenticateRequest } from "./authHandler.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

/**
 * Handles `GET /api/schema` for issue #147: the localized, system-wide projection of every
 * database/property/option, view type, and module-declared agent tool — the API-response
 * counterpart to `generatePermissionManifest`'s per-project manifest, sharing the same
 * `catalogResolution.ts` resolver so both projections resolve labels identically.
 *
 * Locale comes strictly from the authenticated caller's `users.locale` (`identity.user.locale`)
 * — there is deliberately no query or body parameter to override it, so a caller can never see
 * another user's locale by asking for it, and a client always gets back the same language its
 * account is configured for.
 */
export function createSchemaRequestListener(
  pool: Pool,
  moduleRegistry: Parameters<typeof generateSchemaProjection>[1],
) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (url.pathname !== "/api/schema") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const identity = await authenticateRequest(pool, req);

      if (req.method !== "GET") {
        // RFC 7231 §6.5.5: a 405 response MUST include an Allow header listing the permitted methods.
        res.setHeader("Allow", "GET");
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const locale = toManifestLocale(identity.user.locale);

      const projection = await withTransaction(pool, (client) =>
        generateSchemaProjection(client, moduleRegistry, { locale }),
      );
      sendJson(res, 200, projection);
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
   * Same reasoning as `authHandler.ts`'s wrapper: an `async` listener handed straight to
   * `http.createServer` turns any rejection escaping the try/catch above into an unhandled
   * rejection, which Node answers by exiting the whole process over one bad request.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      console.error("Unhandled error in the schema request listener:", err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
