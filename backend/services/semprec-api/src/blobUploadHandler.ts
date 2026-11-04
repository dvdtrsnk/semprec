import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { ChokePointError, MaxBytesExceededError, ValidationError, ingestUploadedBlob } from "@semprec/data";
import type { BlobStorageWriter } from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { requireHeader } from "./adapter/requestValidation.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";
import { sendJson } from "./adapter/http.js";
import { logger } from "./logger.js";

export interface BlobUploadRequestListenerOptions {
  storage: BlobStorageWriter;
  /** Issue #158's `maxFileSizeMb`, already resolved to bytes by `serve.ts`. */
  maxFileSizeBytes: number;
}

/** A media type with optional token or quoted-string parameters. */
const MEDIA_TYPE =
  /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9a-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9a-z-]+|"(?:[^"\\\r\n]|\\[^\r\n])*"))*\s*$/i;

/** Returns the lowercased media type after validating the complete header. */
function requireMediaType(contentType: string): string {
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (!MEDIA_TYPE.test(contentType.trim())) {
    throw new ValidationError("'Content-Type' must be a media type", { field: "Content-Type" });
  }
  return mediaType;
}

/**
 * `POST /api/blobs`: streams a body into a standalone blob without creating a Files item.
 * Same shape as `createFilesRequestListener`: bespoke listener so the body is
 * streamed, not buffered; authenticated through `authenticateRequest`; `maxFileSizeMb` enforced
 * from `Content-Length` first and always by the streaming counter. The content type is validated
 * before any byte is read, so a rejected request leaves nothing in storage.
 */
export function createBlobUploadRequestListener(pool: Pool, options: BlobUploadRequestListenerOptions) {
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

        const mimeType = requireMediaType(requireHeader(req, "Content-Type"));
        const { blob, created } = await ingestUploadedBlob(pool, {
          mimeType,
          source: req,
          maxBytes: options.maxFileSizeBytes,
          storage: options.storage,
        });

        sendJson(res, created ? 201 : 200, {
          blobId: blob.id,
          byteSize: Number(blob.byteSize),
          mimeType: blob.mimeType,
        });
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
