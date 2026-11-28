import type { IncomingMessage, ServerResponse } from "node:http";
import {
  withTransaction,
  ChokePointError,
  generateSchemaProjection,
  toManifestLocale,
  type SchemaDatabaseProjection,
} from "@alldots/data";
import type { ModuleDatabaseProjection } from "@alldots/module-registry";
import type { Pool } from "pg";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { sendJson } from "./adapter/http.js";
import { runInTenant } from "@alldots/shared";
import { authenticateRequest } from "./authHandler.js";
import { logger } from "./logger.js";

/**
 * The declared facet bar property of each database, by key. A declaration is published only when the database has a
 * `select` or `multi_select` property of that key; any other declaration is a configuration error and throws naming
 * only the database key.
 */
function resolveFacetBarProperties(
  databases: readonly SchemaDatabaseProjection[],
  declarations: readonly Pick<ModuleDatabaseProjection, "key" | "facetBarProperty">[],
): Map<string, string> {
  const declared = new Map(
    declarations.flatMap(({ key, facetBarProperty }) =>
      facetBarProperty === undefined ? [] : [[key, facetBarProperty] as const],
    ),
  );
  const resolved = new Map<string, string>();
  for (const database of databases) {
    if (database.key === null) continue;
    const propertyKey = declared.get(database.key);
    if (propertyKey === undefined) continue;
    const property = database.properties.find((candidate) => candidate.key === propertyKey);
    if (property?.type !== "select" && property?.type !== "multi_select") {
      throw new Error(
        `The declared facet bar property of database '${database.key}' is not a select or multi_select property`,
      );
    }
    resolved.set(database.key, propertyKey);
  }
  return resolved;
}

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

        const declarations = await moduleRegistry.getDatabases();
        const projection = await withTransaction(pool, (client) =>
          generateSchemaProjection(client, moduleRegistry, { locale }),
        );
        // Checked against the properties this response publishes; a refused declaration fails the request (500).
        const facetBarProperties = resolveFacetBarProperties(projection.databases, declarations);
        sendJson(res, 200, {
          ...projection,
          databases: projection.databases.map((db) => {
            const facetBarProperty = db.key === null ? undefined : facetBarProperties.get(db.key);
            return { ...db, ...(facetBarProperty === undefined ? {} : { facetBarProperty }) };
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
