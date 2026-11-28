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
} from "@alldots/data";
import { runInTenant } from "@alldots/shared";
import { authenticateRequest } from "./authHandler.js";
import { optionalHeader, requireHeader } from "./adapter/requestValidation.js";
import { toItemEnvelopeWithBlobs } from "./adapter/itemEnvelope.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";
import { sendJson } from "./adapter/http.js";
import { logger } from "./logger.js";

/**
 * The storage key's last path component is `<uuid>-<safeFilename>` (37 bytes of uuid and separator)
 * and sanitizing does not bound length, so this leaves headroom under Linux's 255-byte `NAME_MAX`
 * and refuses here instead of an `ENAMETOOLONG` 500.
 */
const MAX_FILENAME_BYTES = 200;

/**
 * Both or neither. One without the other names the missing header; a non-UUID target names
 * `X-Attach-To-Item`. Read before the body.
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
  maxFileSizeBytes: number;
}

/**
 * A bespoke listener because the body is streamed (`Content-Type` + `X-Filename` headers), while
 * `createAdapterRequestListener` buffers it as JSON.
 *
 * A form that delays filing until Save can instead upload with `POST /api/blobs` and create the
 * Files item through the generic item-create operation with `file: { blobId }`; cancelling creates
 * no item and unreferenced blobs are collected after their grace period.
 *
 * The size cap is enforced from `Content-Length` when present (before a byte is read) and always by
 * the ingest's streaming counter, so a missing or dishonest header can only under-enforce the first
 * check.
 *
 * The optional `X-Attach-To-Item` and `X-Attach-Relation` headers link the file to an item: the
 * target is resolved before the body is read and linked in the ingest transaction, so file and edge
 * commit together.
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

        // Read-only, before any byte is read: an unknown, trashed or foreign target answers the
        // same 404 and an invalid relation key 400, with nothing stored.
        const { filesDatabaseId, target } = await withTransaction(pool, async (client) => {
          const filesDatabase = await getDatabaseByModuleId(client, FILES_MODULE_ID);
          if (!filesDatabase) throw new Error("The 'files' system database is missing");
          return {
            filesDatabaseId: filesDatabase.id,
            target:
              attach && (await resolveUploadAttachTarget(client, { filesDatabaseId: filesDatabase.id, ...attach })),
          };
        });

        // In the ingest transaction, so a failure rolls the new file back and its streamed bytes
        // are deleted; an identical upload reuses its Files item and only gains the edge.
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

  // `http.createServer` discards an async listener's return value, so an escaping rejection would
  // crash the process.
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
