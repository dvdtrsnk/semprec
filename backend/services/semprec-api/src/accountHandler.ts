import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import type { Pool } from "pg";
import {
  ChokePointError,
  deleteOwnAccount,
  getDownloadableTenantExport,
  listTenantExports,
  NotFoundError,
  requestTenantExport,
  ValidationError,
  withTransaction,
  type BlobStorageWriter,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";
import { NO_STORE, sendJson } from "./adapter/http.js";
import { assertUuid, requireJsonObjectBody } from "./adapter/requestValidation.js";
import { clientIpFromRequest } from "./clientIp.js";
import type { RouteDefinition } from "./adapter/routeTable.js";
import type { AppOptions } from "./app.js";
import { logger } from "./logger.js";

/**
 * The account route family (issue #1043): the caller's own account, in the caller's own tenant.
 * Every route is an adapter route, so it is authenticated and runs inside the session's tenant
 * scope. `options` is the dispatcher's own options object; account deletion reads its `trustProxy`.
 */
export function createAccountRoutes(pool: Pool, options: AppOptions): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/api/account/exports",
      handler: async (ctx) => {
        const requested = await withTransaction(pool, (client) => requestTenantExport(client, ctx.identity.user.id));
        return { status: requested.created ? 202 : 200, body: { export: requested.export } };
      },
    },
    {
      method: "GET",
      path: "/api/account/exports",
      handler: async () => ({ status: 200, body: { exports: await listTenantExports(pool) } }),
    },
    {
      method: "POST",
      path: "/api/account/delete",
      handler: async (ctx) => {
        const body = requireJsonObjectBody(ctx.body);
        const password = body.password;
        if (typeof password !== "string" || password.length === 0) {
          throw new ValidationError("'password' must be a non-empty string", { field: "password" });
        }
        await deleteOwnAccount(pool, {
          userId: ctx.identity.user.id,
          tenantId: ctx.identity.tenantId,
          password,
          ip: clientIpFromRequest(ctx.req, { trustProxy: options.trustProxy ?? false }),
        });
        return { status: 202, body: { status: "deleting" } };
      },
    },
  ];
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

const DOWNLOAD_PATH = /^\/api\/account\/exports\/([^/]+)\/download$/;

export interface AccountExportDownloadListenerOptions {
  /** The files root, where `tenantExport` writes its archives. */
  storage: BlobStorageWriter;
}

/**
 * `GET /api/account/exports/:id/download` (issue #1043): streams a `ready`, unexpired export of the
 * caller's tenant. Like `blobsHandler.ts` it is a bespoke listener, because the body is piped, not
 * a JSON envelope. The id is validated first, then the session is authenticated, and the export is
 * resolved inside the session's tenant: a foreign, unknown, not-ready or expired id is the same 404.
 */
export function createAccountExportDownloadListener(pool: Pool, options: AccountExportDownloadListenerOptions) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const match = DOWNLOAD_PATH.exec(url.pathname);
      if (!match) {
        sendJson(res, 404, { error: { code: "not_found" } });
        return;
      }
      // Group 1 of DOWNLOAD_PATH is not optional, so a successful match always captured it.
      const exportId = assertUuid(match[1]!, "id");
      const identity = await authenticateRequest(pool, req);

      await runInTenant(identity.tenantId, async () => {
        const download = await getDownloadableTenantExport(pool, exportId);
        if (!download) throw new NotFoundError(`Export ${exportId} not found`);

        const stream = options.storage.readStream(download.storageKey);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": String(download.byteSize),
          "Content-Disposition": `attachment; filename="semprec-export-${download.completedAt.slice(0, 10)}.zip"`,
          "Cache-Control": NO_STORE,
        });

        // Not awaited, as in blobsHandler.ts: pipeline destroys the read stream when the client
        // aborts, so the file descriptor is released.
        pipeline(stream, res, (err) => {
          if (!err) return;
          if (err.code === "ERR_STREAM_PREMATURE_CLOSE") {
            logger.debug({ exportId }, "Client aborted export download");
            return;
          }
          logger.error({ errorName: err.name, errorCode: err.code, exportId }, "Error streaming export");
          res.destroy();
        });
      });
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, statusForError(err), toErrorResponseBody(err));
        return;
      }
      logger.error(
        { errorName: errorName(err), method: req.method, path: url.pathname },
        "Unexpected error handling request",
      );
      sendJson(res, 500, { error: { code: "internal_error" } });
    }
  }

  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ errorName: errorName(err) }, "Unhandled error in the request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: "internal_error" } });
    });
  };
}
