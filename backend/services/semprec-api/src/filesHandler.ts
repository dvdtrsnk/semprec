import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  ChokePointError,
  MaxBytesExceededError,
  ValidationError,
  withTransaction,
  getDatabaseByModuleId,
  FILES_MODULE_ID,
  ingestUploadedFile,
  type BlobStorageWriter,
} from "@semprec/data";
import { authenticateRequest } from "./authHandler.js";
import { requireHeader } from "./adapter/requestValidation.js";
import { toItemEnvelope } from "./adapter/itemEnvelope.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";

/**
 * `fileUploadStore.ts` builds the storage key's last path component as `<uuid>-<safeFilename>`
 * (37 bytes for the uuid and separator) — `safeStorageFilename` sanitizes characters but not
 * length, so this leaves headroom under Linux's 255-byte `NAME_MAX` per path component and
 * rejects here rather than surfacing as an `ENAMETOOLONG` 500 once it reaches the filesystem.
 */
const MAX_FILENAME_BYTES = 200;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

export interface FilesRequestListenerOptions {
  storage: BlobStorageWriter;
  /** Issue #158's `maxFileSizeMb`, already resolved to bytes by `serve.ts`. */
  maxFileSizeBytes: number;
}

/**
 * `POST /api/files` (issue #158): a raw streamed body (`Content-Type` + `X-Filename` headers, not
 * a JSON payload), so unlike every other route family this service mounts, it can't go through
 * `createAdapterRequestListener` — that shared wrapper buffers the whole body as JSON before a
 * handler ever runs, which is exactly what streaming is meant to avoid. Same shape as
 * `notificationsHandler.ts`'s bespoke listener: authenticates the same way
 * (`authenticateRequest`), maps a `ChokePointError` through the same `errorContract.ts` this
 * adapter's other routes use, just without the JSON-body step.
 *
 * `maxFileSizeMb` is enforced twice, per the issue's Task: first cheaply from `Content-Length`
 * when the client sent one (rejecting before a single byte of the body is read), and always
 * through `ingestUploadedFile`'s streaming byte counter — a missing, chunked, or dishonest
 * `Content-Length` can only ever under-enforce the header check, never bypass the counter.
 */
export function createFilesRequestListener(pool: Pool, options: FilesRequestListenerOptions) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await authenticateRequest(pool, req);

      const contentLengthHeader = req.headers["content-length"];
      if (typeof contentLengthHeader === "string") {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > options.maxFileSizeBytes) {
          req.resume();
          sendJson(res, 413, { error: { code: "payload_too_large" } });
          return;
        }
      }

      const contentType = requireHeader(req, "Content-Type");
      const filename = requireHeader(req, "X-Filename");
      if (Buffer.byteLength(filename, "utf8") > MAX_FILENAME_BYTES) {
        throw new ValidationError(`'X-Filename' must be at most ${MAX_FILENAME_BYTES} bytes`, { field: "X-Filename" });
      }

      const filesDatabase = await withTransaction(pool, (client) => getDatabaseByModuleId(client, FILES_MODULE_ID));
      if (!filesDatabase) throw new Error("The 'files' system database is missing");

      const { item, created } = await ingestUploadedFile(pool, {
        filesDatabaseId: filesDatabase.id,
        filename,
        contentType,
        source: req,
        storageKeyPrefix: "files",
        maxBytes: options.maxFileSizeBytes,
        storage: options.storage,
      });

      sendJson(res, created ? 201 : 200, toItemEnvelope(item));
    } catch (err) {
      if (err instanceof MaxBytesExceededError) {
        req.resume();
        sendJson(res, 413, { error: { code: "payload_too_large" } });
        return;
      }
      if (err instanceof ChokePointError) {
        sendJson(res, statusForError(err), toErrorResponseBody(err));
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const errInfo = err instanceof Error ? (err.stack ?? err.message) : err;
      console.error(`Unexpected error in ${req.method} ${pathname}:`, errInfo);
      sendJson(res, 500, { error: { code: "internal_error" } });
    }
  }

  // Same shape as every other bespoke listener in this service (`notificationsHandler.ts`,
  // `authHandler.ts`): `http.createServer` discards an async listener's return value, so an
  // unhandled rejection escaping the try/catch above would otherwise crash the process.
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      const errInfo = err instanceof Error ? (err.stack ?? err.message) : err;
      console.error("Unhandled error in the request listener:", errInfo);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: "internal_error" } });
    });
  };
}
