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
 * `?disposition=inline` (issue #158) is only honored for MIME types that are safe for a browser
 * to render directly in the same origin — deliberately excludes anything HTML/script-capable
 * (`text/html`, `image/svg+xml`, `application/xhtml+xml`, …), since an attacker-supplied blob
 * rendered inline under this API's origin would otherwise be a stored-XSS vector. Anything not in
 * this set always downloads as `attachment`, regardless of the query parameter.
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
 * A single `bytes=start-end` range (RFC 7233 §2.1) against a resource of `size` bytes. A
 * syntactically valid but out-of-bounds range is `"unsatisfiable"` (416); anything the regex
 * doesn't recognize at all is treated as absent — RFC 7233 §3.1: a server that doesn't understand
 * a Range header must serve the full representation, not fail the request.
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

/** `If-None-Match` (RFC 7232 §3.2): `"*"` or a comma-separated list of (optionally weak) entity tags. */
function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}

/**
 * RFC 6266 + RFC 5987: an ASCII-only fallback `filename=` (control characters, quotes and
 * backslashes stripped so nothing can break out of the quoted string or inject a second header
 * directive) plus a percent-encoded UTF-8 `filename*` for clients that support it — malicious or
 * merely non-ASCII filenames stay display-only, never header-structural.
 */
function contentDispositionHeader(kind: "inline" | "attachment", filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * The blob and its download filename, read in one transaction in the caller's tenant. `null` when
 * the blob is not visible there, so a foreign id and an unknown id take the same path. The filename
 * is the lowest-id Files item pointing at this blob (same convergence lookup `POST /api/files` dedup
 * uses), if any — its `name` property is the best available display filename for a download that
 * only knows a blob id.
 */
async function resolveDownload(pool: Pool, blobId: string): Promise<{ blob: BlobRow; filename: string } | null> {
  return withTransaction(pool, async (client) => {
    const blob = await getBlob(client, blobId);
    if (!blob) return null;
    const filesDatabase = await getDatabaseByModuleId(client, FILES_MODULE_ID);
    const item = filesDatabase ? await findFileItemByBlobId(client, filesDatabase.id, blob.id) : null;
    const name = item && typeof item.properties.name === "string" ? item.properties.name : undefined;
    return { blob, filename: name && name.length > 0 ? name : blob.id };
  });
}

export interface BlobsRequestListenerOptions {
  storage: BlobStorageWriter;
}

/**
 * `GET /api/blobs/:id` (issue #158): authenticated, streamed, `Range`/conditional-request aware.
 * Like `filesHandler.ts`, this can't go through `createAdapterRequestListener` — a binary
 * download's response isn't a JSON envelope and its body is piped, not buffered — so it's a
 * bespoke listener the same way `notificationsHandler.ts` is, sharing this adapter's auth and
 * error-code contract without its JSON-specific machinery.
 *
 * What the caller may see is decided first, in the caller's tenant: the blob and its filename are
 * read in one transaction before any conditional branch (`304`, `416`), so a foreign blob id
 * answers exactly like an unknown one.
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
        // Group 1 of BLOB_PATH is not optional, so a successful match always captured it.
        const blobId = assertUuid(match[1]!, "id");

        // Decided before any conditional branch: a blob this tenant cannot see never reaches the 304 or 416 answers.
        const download = await resolveDownload(pool, blobId);
        if (!download) throw new NotFoundError(`Blob ${blobId} not found`);
        const { blob, filename } = download;

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

        const stream = options.storage.readStream(blob.storageKey, range);

        if (range) {
          headers["Content-Range"] = `bytes ${range.start}-${range.end}/${byteSize}`;
          headers["Content-Length"] = String(range.end - range.start + 1);
          res.writeHead(206, headers);
        } else {
          headers["Content-Length"] = String(byteSize);
          res.writeHead(200, headers);
        }

        // Not awaited: handleRequest returns once headers are written, and handleRequestSafely
        // only guards the pre-stream phase. pipeline (unlike pipe) destroys the other side on
        // premature close of either stream, so an aborted client releases the read stream's fd.
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
