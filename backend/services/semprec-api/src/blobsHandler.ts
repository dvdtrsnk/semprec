import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import type { Pool } from "pg";
import {
  ChokePointError,
  NotFoundError,
  withTransaction,
  getDatabaseByModuleId,
  findFileItemByBlobId,
  getBlob,
  openBlobFromRoots,
  primaryRootForBlob,
  type BlobRootName,
  FILES_MODULE_ID,
  type BlobRow,
  type BlobStorageWriter,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";
import { NO_STORE, sendJson } from "./adapter/http.js";
import { assertUuid } from "./adapter/requestValidation.js";
import { logger } from "./logger.js";

const BLOB_PATH = /^\/api\/blobs\/([^/]+)$/;

/**
 * Excludes anything HTML/script-capable (`text/html`, `image/svg+xml`, ...): such a blob rendered
 * inline under this origin would be a stored-XSS vector. Anything else always downloads as
 * `attachment`.
 */
const INLINE_SAFE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

interface ParsedRange {
  start: number;
  end: number;
}

/**
 * A single `bytes=start-end` range. An out-of-bounds range is `"unsatisfiable"` (416); an
 * unrecognized header is treated as absent, since RFC 7233 §3.1 says to serve the full
 * representation.
 */
function parseRange(header: string | undefined, size: number): ParsedRange | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return undefined;

  let start: number;
  let end: number;
  if (startStr === "") {
    const suffixLength = Number(endStr);
    if (suffixLength === 0) return "unsatisfiable";
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Number(endStr);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start < 0 || start >= size) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}

function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}

/**
 * An ASCII-only `filename=` fallback (control characters, quotes and backslashes stripped so
 * nothing breaks out of the quoted string) plus a percent-encoded UTF-8 `filename*`, so filenames
 * stay display-only, never header-structural.
 */
function contentDispositionHeader(kind: "inline" | "attachment", filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * `null` when the blob is not visible in the caller's tenant, so a foreign and an unknown id take
 * the same path. The filename is the `name` of the lowest-id Files item pointing at the blob (the
 * convergence lookup `POST /api/files` dedup uses).
 */
async function resolveDownload(
  pool: Pool,
  blobId: string,
): Promise<{ blob: BlobRow; filename: string; primaryRoot: BlobRootName } | null> {
  return withTransaction(pool, async (client) => {
    const blob = await getBlob(client, blobId);
    if (!blob) return null;
    const filesDatabase = await getDatabaseByModuleId(client, FILES_MODULE_ID);
    const item = filesDatabase ? await findFileItemByBlobId(client, filesDatabase.id, blob.id) : null;
    const name = item && typeof item.properties.name === "string" ? item.properties.name : undefined;
    const primaryRoot = await primaryRootForBlob(client, blob.id);
    return { blob, filename: name && name.length > 0 ? name : blob.id, primaryRoot };
  });
}

export interface BlobsRequestListenerOptions {
  /** Uploads under `files`, synced mail attachments under `mailAttachments`. */
  files: BlobStorageWriter;
  mailAttachments: BlobStorageWriter;
}

/**
 * A bespoke listener because a binary download is piped, not a JSON envelope. The blob and filename
 * are read before any conditional branch (`304`, `416`), so a foreign blob id answers exactly like
 * an unknown one.
 */
export function createBlobsRequestListener(pool: Pool, options: BlobsRequestListenerOptions) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const identity = await authenticateRequest(pool, req);

      await runInTenant(identity.tenantId, async () => {
        const match = BLOB_PATH.exec(url.pathname);
        if (!match) {
          sendJson(res, 404, { error: { code: "not_found" } });
          return;
        }
        // Group 1 of BLOB_PATH is not optional.
        const blobId = assertUuid(match[1]!, "id");

        // A blob this tenant cannot see never reaches the 304 or 416 answers.
        const download = await resolveDownload(pool, blobId);
        if (!download) throw new NotFoundError(`Blob ${blobId} not found`);
        const { blob, filename, primaryRoot } = download;

        const byteSize = Number(blob.byteSize);
        const etag = blob.contentHash ? `"${blob.contentHash}"` : undefined;

        const ifNoneMatch = req.headers["if-none-match"];
        if (etag && ifNoneMatchMatches(typeof ifNoneMatch === "string" ? ifNoneMatch : undefined, etag)) {
          res.writeHead(304, { ETag: etag, "Cache-Control": NO_STORE });
          res.end();
          return;
        }

        const rangeHeader = req.headers.range;
        const range = parseRange(typeof rangeHeader === "string" ? rangeHeader : undefined, byteSize);
        if (range === "unsatisfiable") {
          res.writeHead(416, { "Content-Range": `bytes */${byteSize}`, "Cache-Control": NO_STORE });
          res.end();
          return;
        }

        const wantsInline = url.searchParams.get("disposition") === "inline";
        const disposition = wantsInline && INLINE_SAFE_MIME_TYPES.has(blob.mimeType) ? "inline" : "attachment";

        const headers: Record<string, string> = {
          "Content-Type": blob.mimeType,
          "Accept-Ranges": "bytes",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": contentDispositionHeader(disposition, filename),
        };
        if (etag) headers.ETag = etag;
        headers["Cache-Control"] = NO_STORE;

        // Opened before any header is written, so a missing or unreadable file still gets a JSON
        // error status.
        const stream = await openBlobFromRoots({
          primary: options[primaryRoot],
          alternate: primaryRoot === "files" ? options.mailAttachments : options.files,
          storageKey: blob.storageKey,
          range,
        });
        if (!stream) throw new NotFoundError(`Blob ${blobId} has no stored bytes`);

        if (range) {
          headers["Content-Range"] = `bytes ${range.start}-${range.end}/${byteSize}`;
          headers["Content-Length"] = String(range.end - range.start + 1);
          res.writeHead(206, headers);
        } else {
          headers["Content-Length"] = String(byteSize);
          res.writeHead(200, headers);
        }

        // Not awaited: handleRequestSafely only guards the pre-stream phase. pipeline (unlike pipe)
        // destroys the other side on premature close, so an aborted client releases the read
        // stream's fd.
        pipeline(stream, res, (err) => {
          if (!err) return;
          if (err.code === "ERR_STREAM_PREMATURE_CLOSE") {
            logger.debug({ blobId }, "Client aborted blob download");
            return;
          }
          logger.error({ err, blobId }, "Error streaming blob");
          res.destroy();
        });
      });
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, statusForError(err), toErrorResponseBody(err));
        return;
      }
      logger.error({ err, method: req.method, path: url.pathname }, "Unexpected error handling request");
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
