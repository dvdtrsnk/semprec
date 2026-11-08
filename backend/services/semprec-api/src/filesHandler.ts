import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { z } from "zod";
import {
  ChokePointError,
  MaxBytesExceededError,
  ValidationError,
  withTransaction,
  getDatabaseByModuleId,
  FILES_MODULE_ID,
  attachUploadedFileWithClient,
  ingestUploadedFileWithTransaction,
  resolveUploadAttachTarget,
  type BlobStorageWriter,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { optionalHeader, requireHeader } from "./adapter/requestValidation.js";
import { toItemEnvelopeWithBlobs } from "./adapter/itemEnvelope.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";
import { sendJson } from "./adapter/http.js";
import { logger } from "./logger.js";

/**
 * `fileUploadStore.ts` builds the storage key's last path component as `<uuid>-<safeFilename>`
 * (37 bytes for the uuid and separator) — `safeStorageFilename` sanitizes characters but not
 * length, so this leaves headroom under Linux's 255-byte `NAME_MAX` per path component and
 * rejects here rather than surfacing as an `ENAMETOOLONG` 500 once it reaches the filesystem.
 */
const MAX_FILENAME_BYTES = 200;

/**
 * Issue #1645's optional attach headers: both or neither. One without the other names the missing
 * header; a target id that is not a UUID names `X-Attach-To-Item`. Read before the body.
 */
function readAttachHeaders(req: IncomingMessage): { targetItemId: string; relationKey: string } | null {
  const targetItemId = optionalHeader(req, "X-Attach-To-Item");
  const relationKey = optionalHeader(req, "X-Attach-Relation");
  if (targetItemId === undefined && relationKey === undefined) return null;
  if (targetItemId === undefined) {
    throw new ValidationError("'X-Attach-To-Item' is required with 'X-Attach-Relation'", { field: "X-Attach-To-Item" });
  }
  if (relationKey === undefined) {
    throw new ValidationError("'X-Attach-Relation' is required with 'X-Attach-To-Item'", {
      field: "X-Attach-Relation",
    });
  }
  if (!z.uuid().safeParse(targetItemId).success) {
    throw new ValidationError("'X-Attach-To-Item' must be an item id", { field: "X-Attach-To-Item" });
  }
  return { targetItemId, relationKey };
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
 * A form that delays filing until Save can instead upload bytes with `POST /api/blobs`, then
 * create a Files item through the generic item-create operation with `file: { blobId }` and
 * initial relations. Cancelling after upload creates no Files item; unreferenced blobs are
 * collected after their grace period. Reusing a deduplicated blob creates a separate item.
 *
 * `maxFileSizeMb` is enforced twice, per the issue's Task: first cheaply from `Content-Length`
 * when the client sent one (rejecting before a single byte of the body is read), and always
 * through the ingest's streaming byte counter (`ingestUploadedFileWithTransaction`) — a missing,
 * chunked, or dishonest `Content-Length` can only ever under-enforce the header check, never bypass
 * the counter.
 *
 * The optional `X-Attach-To-Item` and `X-Attach-Relation` headers (issue #1645) link the uploaded
 * file to an item in the same request: the target is resolved before the body is read
 * (`resolveUploadAttachTarget`) and linked in the ingest transaction (`attachUploadedFileWithClient`),
 * so the file and its edge commit together. Without them the route behaves as it did before.
 */
export function createFilesRequestListener(pool: Pool, options: FilesRequestListenerOptions) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const identity = await authenticateRequest(pool, req);

      await runInTenant(identity.tenantId, async () => {
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
          throw new ValidationError(`'X-Filename' must be at most ${MAX_FILENAME_BYTES} bytes`, {
            field: "X-Filename",
          });
        }

        const attach = readAttachHeaders(req);

        // Read-only, before a byte of the body is read: an unknown, trashed or foreign target answers the
        // same 404, and an invalid relation key 400, with nothing streamed or stored (issue #1645).
        const { filesDatabaseId, target } = await withTransaction(pool, async (client) => {
          const filesDatabase = await getDatabaseByModuleId(client, FILES_MODULE_ID);
          if (!filesDatabase) throw new Error("The 'files' system database is missing");
          return {
            filesDatabaseId: filesDatabase.id,
            target:
              attach && (await resolveUploadAttachTarget(client, { filesDatabaseId: filesDatabase.id, ...attach })),
          };
        });

        // The edge is written in the ingest transaction, so a failure rolls the new file back and its
        // streamed bytes are deleted; an identical upload reuses its Files item and only gains the edge.
        const { result } = await ingestUploadedFileWithTransaction(
          pool,
          {
            filesDatabaseId,
            filename,
            contentType,
            source: req,
            storageKeyPrefix: "files",
            maxBytes: options.maxFileSizeBytes,
            storage: options.storage,
          },
          async (client, file) => {
            if (target) {
              await attachUploadedFileWithClient(client, target, file.item.id, file.blob.id, {
                writer: { writerKind: "user" },
                actingUserId: identity.user.id,
              });
            }
          },
        );

        sendJson(res, result.created ? 201 : 200, await toItemEnvelopeWithBlobs(pool, result.item));
      });
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
      logger.error({ err, method: req.method, path: pathname }, "Unexpected error handling request");
      sendJson(res, 500, { error: { code: "internal_error" } });
    }
  }

  // Same shape as every other bespoke listener in this service (`notificationsHandler.ts`,
  // `authHandler.ts`): `http.createServer` discards an async listener's return value, so an
  // unhandled rejection escaping the try/catch above would otherwise crash the process.
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: "internal_error" } });
    });
  };
}
