import type { IncomingMessage, ServerResponse } from "node:http";
import {
  withTransaction,
  ChokePointError,
  generateSchemaProjection,
  resolveDatabaseAreaFilters,
  toManifestLocale,
} from "@semprec/data";
import type { Pool } from "pg";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { sendJson } from "./adapter/http.js";
import { runInTenant } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { logger } from "./logger.js";

/**
 * The localized, system-wide projection of every database, property, option, view type and module
 * agent tool, sharing `catalogResolution.ts` with `generatePermissionManifest` so both resolve
 * labels identically.
 *
 * Locale comes only from the caller's `users.locale`; there is deliberately no parameter to
 * override it.
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

      await runInTenant(identity.tenantId, async () => {
        if (req.method !== "GET") {
          // RFC 7231 §6.5.5: a 405 response must include an Allow header.
          res.setHeader("Allow", "GET");
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        const locale = toManifestLocale(identity.user.locale);

        // Each system database's declared area filter template, so a client substitutes an area id
        // instead of assembling the rule. A template is published only once the filter compiler
        // accepted it against this tenant's schema in the projection's transaction; a refused one
        // fails the request (500) rather than being published or dropped.
        const { projection, areaFilters } = await withTransaction(pool, async (client) => ({
          projection: await generateSchemaProjection(client, moduleRegistry, { locale }),
          areaFilters: await resolveDatabaseAreaFilters(client, await moduleRegistry.getDatabases()),
        }));
        sendJson(res, 200, {
          ...projection,
          databases: projection.databases.map((db) => {
            const areaFilter = db.key === null ? undefined : areaFilters.get(db.key);
            return areaFilter === undefined ? db : { ...db, areaFilter };
          }),
        });
      });
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, toPublicErrorBody(err));
        return;
      }
      logger.error({ err, method: req.method, path: url.pathname }, "Unexpected error handling request");
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * `http.createServer` discards the listener's return value, so an async rejection would exit the
   * process over one bad request.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the schema request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
